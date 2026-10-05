// TaskScheduler — reminders & recurring agent tasks for the Cairn assistant (SPEC-ASSISTANT "scheduler").
//
// - One setTimeout armed to the next due time, capped at tickMs, always unref()'d (never keeps the
//   process alive). Capping means a machine that slept catches up within tickMs of waking.
// - On tick every active task with nextRunAt <= now fires `emit('due', task)` exactly once; the new
//   state (advanced nextRunAt or status:'done') is persisted BEFORE listeners run, so a crash or
//   restart never re-fires the same occurrence.
// - Missed occurrences (sleep, server down) are skipped: a recurring task fires once and jumps to
//   its first occurrence after `now` — no burst. Overdue one-shots found at start fire once.
// - Persistence: atomic JSON (write tmp + rename) to `file` on every change.
//
// Events:
//   'due'    (task & {dueAt, lateMs, manual?})  — deliver a reminder / start an agent run
//   'change' ({action, task})                    — add | update | cancel | remove | fired | run
//   'error'  (err)                               — only emitted when an 'error' listener exists
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseWhen, nextOccurrence, firstOccurrence, normalizeRecurrence, toDate, formatAt, DAY_NAMES } from './when.js';

export { parseWhen, nextOccurrence, firstOccurrence, normalizeRecurrence, describeRecurrence, toLocalISO } from './when.js';

const KINDS = new Set(['reminder', 'agent']);
const STATUSES = new Set(['active', 'done', 'cancelled']);
const MAX_RUNS = 20;
const MAX_INACTIVE = 200;
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function invalid(message) {
  const err = new Error(message);
  err.code = 'EINVAL';
  err.status = 400;
  return err;
}

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const trunc = (s, n) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const optText = (v, n = MAX_TEXT) => (v == null || v === '' ? null : trunc(String(v), n));

function byNextRun(a, b) {
  const x = Date.parse(a.nextRunAt);
  const y = Date.parse(b.nextRunAt);
  const xa = Number.isNaN(x) ? Infinity : x;
  const ya = Number.isNaN(y) ? Infinity : y;
  return xa - ya || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));
}

/** Fill `at` / `days` for calendar recurrences from the first run so wall-clock time never drifts. */
function anchorRecurrence(rec, first) {
  if (!rec || !first) return rec;
  const out = { ...rec };
  if (out.every === 'day' || out.every === 'weekday' || out.every === 'week') {
    if (!out.at) out.at = formatAt({ h: first.getHours(), m: first.getMinutes() });
    if (out.every === 'week' && !out.days) out.days = [DAY_NAMES[first.getDay()]];
  }
  return out;
}

/** `when` may be a Date, epoch ms, ISO string, or natural language ("tomorrow at 9am"). */
function resolveWhen(when, now) {
  const d = toDate(when);
  if (d) return { date: d, recurrence: null, title: '' };
  if (typeof when === 'string') {
    const p = parseWhen(when, now);
    if (p) return { date: new Date(p.when), recurrence: p.recurrence, title: p.title };
  }
  return null;
}

export class TaskScheduler extends EventEmitter {
  constructor({ file = null, now = () => new Date(), tickMs = 5000 } = {}) {
    super();
    this.file = file || null;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.tickMs = Math.max(20, Number(tickMs) || 5000);
    this.tasks = new Map();
    this.loadError = null;
    this.lastSaveError = null;
    this._timer = null;
    this._started = false;
    this._ticking = false;
    this._load();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start the background loop. Fires any overdue tasks immediately (once each). */
  start() {
    if (this._started) return this;
    this._started = true;
    this.tick();
    return this;
  }

  stop() {
    this._started = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    return this;
  }

  close() {
    return this.stop();
  }

  get running() {
    return this._started;
  }

  // ---------------------------------------------------------------- queries

  get(id) {
    const t = this.tasks.get(String(id));
    return t ? clone(t) : null;
  }

  /** Active tasks sorted by nextRunAt (soonest first); includeDone appends done/cancelled (most recent first). */
  list({ includeDone = false, kind = null } = {}) {
    let all = [...this.tasks.values()];
    if (kind) all = all.filter((t) => t.kind === kind);
    const active = all.filter((t) => t.status === 'active').sort(byNextRun);
    if (!includeDone) return active.map(clone);
    const inactive = all.filter((t) => t.status !== 'active').sort((a, b) => byNextRun(b, a));
    return [...active, ...inactive].map(clone);
  }

  /** ISO time of the soonest active task, or null. */
  nextTaskAt() {
    const ms = this._nextDueMs();
    return ms == null ? null : new Date(ms).toISOString();
  }

  stats() {
    const out = { total: this.tasks.size, active: 0, done: 0, cancelled: 0, nextTaskAt: this.nextTaskAt(), running: this._started };
    for (const t of this.tasks.values()) out[t.status] = (out[t.status] || 0) + 1;
    return out;
  }

  // ---------------------------------------------------------------- mutations

  add({ title, kind = 'reminder', when, recurrence = null, prompt, notes } = {}) {
    const nowD = this._nowDate();
    kind = String(kind || 'reminder').toLowerCase();
    if (!KINDS.has(kind)) throw invalid(`kind must be 'reminder' or 'agent' (got ${JSON.stringify(kind)})`);
    let rec = normalizeRecurrence(recurrence);
    let first = null;
    let parsedTitle = '';
    if (when != null && when !== '') {
      const r = resolveWhen(when, nowD);
      if (!r) throw invalid(`Could not understand when: ${JSON.stringify(String(when)).slice(0, 120)}`);
      first = r.date;
      parsedTitle = r.title || '';
      if (!rec && r.recurrence) rec = normalizeRecurrence(r.recurrence);
    }
    if (!first) {
      if (!rec) throw invalid('when (ISO date-time) or recurrence is required');
      first = firstOccurrence(rec, nowD);
      if (!first) throw invalid('recurrence has no future occurrence');
    }
    rec = anchorRecurrence(rec, first);
    // A recurring task whose first run is already in the past (e.g. "every day at 8am" sent at 10am
    // as today 08:00) starts at its next future occurrence instead of firing immediately.
    // One-shots in the past are kept: they fire on the next tick (overdue).
    if (rec && first.getTime() < nowD.getTime() - MINUTE_MS) {
      const rolled = this._nextAfter(rec, first.getTime(), nowD.getTime());
      if (rolled) first = rolled;
    }

    let cleanTitle = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (!cleanTitle) cleanTitle = parsedTitle;
    if (!cleanTitle && prompt) cleanTitle = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!cleanTitle) cleanTitle = kind === 'agent' ? 'Scheduled task' : 'Reminder';

    const nowIso = nowD.toISOString();
    const task = {
      id: `task_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
      title: trunc(cleanTitle, MAX_TITLE),
      kind,
      prompt: optText(prompt) ?? (kind === 'agent' ? cleanTitle : null),
      notes: optText(notes),
      recurrence: rec,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: first.toISOString(),
      lastRunAt: null,
      runs: [],
    };
    this.tasks.set(task.id, task);
    this._changed('add', task);
    return clone(task);
  }

  /** Patch title/kind/prompt/notes/when/recurrence/status. Returns the task, or null if unknown. */
  update(id, patch = {}) {
    const t = this.tasks.get(String(id));
    if (!t) return null;
    if (!patch || typeof patch !== 'object') throw invalid('patch must be an object');
    const nowD = this._nowDate();
    const next = { ...t };
    if ('title' in patch) {
      const s = String(patch.title ?? '').replace(/\s+/g, ' ').trim();
      if (!s) throw invalid('title must not be empty');
      next.title = trunc(s, MAX_TITLE);
    }
    if ('kind' in patch) {
      const k = String(patch.kind || '').toLowerCase();
      if (!KINDS.has(k)) throw invalid(`kind must be 'reminder' or 'agent'`);
      next.kind = k;
    }
    if ('prompt' in patch) next.prompt = optText(patch.prompt);
    if ('notes' in patch) next.notes = optText(patch.notes);
    if (next.kind === 'agent' && !next.prompt) next.prompt = next.title;
    let whenDate = null;
    if ('when' in patch && patch.when != null && patch.when !== '') {
      const r = resolveWhen(patch.when, nowD);
      if (!r) throw invalid(`Could not understand when: ${JSON.stringify(String(patch.when)).slice(0, 120)}`);
      whenDate = r.date;
      if (!('recurrence' in patch) && r.recurrence) patch = { ...patch, recurrence: r.recurrence };
    }
    if ('recurrence' in patch) {
      const rec = normalizeRecurrence(patch.recurrence);
      if (rec) {
        const first = whenDate || firstOccurrence(rec, nowD);
        next.recurrence = anchorRecurrence(rec, first);
        next.nextRunAt = first.toISOString();
      } else {
        next.recurrence = null;
      }
    }
    if (whenDate) next.nextRunAt = whenDate.toISOString();
    if ('status' in patch) {
      const s = String(patch.status || '').toLowerCase();
      if (!STATUSES.has(s)) throw invalid(`status must be one of ${[...STATUSES].join('|')}`);
      next.status = s;
    }
    next.updatedAt = nowD.toISOString();
    Object.assign(t, next);
    this._changed('update', t);
    return clone(t);
  }

  /** Cancel an active task (idempotent). Returns the task, or null if unknown. */
  cancel(id) {
    const t = this.tasks.get(String(id));
    if (!t) return null;
    if (t.status === 'active') {
      t.status = 'cancelled';
      t.updatedAt = this._nowDate().toISOString();
      this._changed('cancel', t);
    }
    return clone(t);
  }

  /** Hard-delete a task. Returns true if it existed. */
  remove(id) {
    const t = this.tasks.get(String(id));
    if (!t) return false;
    this.tasks.delete(t.id);
    this._changed('remove', t);
    return true;
  }

  /**
   * Fire a task immediately (emits 'due' with manual:true). Does not consume or move the
   * scheduled occurrence. Returns the task, or null if unknown.
   */
  runNow(id) {
    const t = this.tasks.get(String(id));
    if (!t) return null;
    const nowD = this._nowDate();
    const at = nowD.toISOString();
    t.lastRunAt = at;
    this._pushRun(t, this._startedRun(t, at, true));
    t.updatedAt = at;
    this._changed('run', t);
    this._emitSafe('due', { ...clone(t), dueAt: at, lateMs: 0, manual: true });
    return clone(t);
  }

  /**
   * Record the outcome of a run (agent tasks call this after agent.runOnce). Completes the pending
   * run entry created when the task fired, or appends a new entry. Returns the task, or null.
   */
  markRun(id, { ok = true, summary = '', at } = {}) {
    const t = this.tasks.get(String(id));
    if (!t) return null;
    const nowIso = this._nowDate().toISOString();
    const last = t.runs[t.runs.length - 1];
    const entry = { ok: !!ok, summary: trunc(summary == null ? '' : String(summary), 500) };
    if (last && last.ok === null) {
      Object.assign(last, entry, { finishedAt: nowIso });
    } else {
      const atIso = (at && toDate(at)?.toISOString()) || nowIso;
      this._pushRun(t, { at: atIso, ...entry });
      t.lastRunAt = atIso;
    }
    t.updatedAt = nowIso;
    this._changed('update', t);
    return clone(t);
  }

  // ---------------------------------------------------------------- ticking

  /** Process due tasks now. Returns the snapshots that fired. Safe to call manually (tests). */
  tick() {
    if (this._ticking) return [];
    this._ticking = true;
    const fired = [];
    try {
      const nowMs = this._nowMs();
      const due = [...this.tasks.values()]
        .filter((t) => t.status === 'active' && !(Date.parse(t.nextRunAt) > nowMs))
        .sort(byNextRun);
      for (const t of due) {
        const dueAt = t.nextRunAt;
        this._advance(t, nowMs);
        const dueMs = Date.parse(dueAt);
        fired.push({ ...clone(t), dueAt, lateMs: Number.isNaN(dueMs) ? 0 : Math.max(0, nowMs - dueMs) });
      }
      if (fired.length) this._save(); // persist BEFORE notifying → no duplicate firing after a crash
      for (const snap of fired) {
        this._emitSafe('change', { action: 'fired', task: clone(snap) });
        this._emitSafe('due', snap);
      }
    } finally {
      this._ticking = false;
    }
    this._arm();
    return fired.map(clone);
  }

  _advance(t, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    t.lastRunAt = nowIso;
    t.updatedAt = nowIso;
    this._pushRun(t, this._startedRun(t, nowIso, false));
    if (!t.recurrence) {
      t.status = 'done';
      return;
    }
    let next = null;
    try {
      next = this._nextAfter(t.recurrence, Date.parse(t.nextRunAt), nowMs);
    } catch {
      next = null;
    }
    if (next) t.nextRunAt = next.toISOString();
    else t.status = 'done';
  }

  /** First occurrence after `nowMs`, stepping from the due occurrence (keeps phase, skips missed ones). */
  _nextAfter(rec, dueMs, nowMs) {
    const from = Number.isNaN(dueMs) ? nowMs : Math.min(dueMs, nowMs);
    if ((rec.every === 'minute' || rec.every === 'hour') && !rec.days) {
      const step = (rec.interval || 1) * (rec.every === 'minute' ? MINUTE_MS : HOUR_MS);
      const k = Math.floor((nowMs - from) / step) + 1;
      return new Date(from + k * step);
    }
    let next = nextOccurrence(rec, new Date(from));
    for (let i = 0; next && next.getTime() <= nowMs && i < 2000; i++) next = nextOccurrence(rec, next);
    if (next && next.getTime() <= nowMs) next = nextOccurrence(rec, new Date(nowMs));
    return next;
  }

  _startedRun(t, at, manual) {
    const run = t.kind === 'reminder'
      ? { at, ok: true, summary: manual ? 'Reminder delivered (run now)' : 'Reminder delivered' }
      : { at, ok: null, summary: manual ? 'Running (run now)…' : 'Running…' };
    if (manual) run.manual = true;
    return run;
  }

  _pushRun(t, run) {
    t.runs.push(run);
    if (t.runs.length > MAX_RUNS) t.runs.splice(0, t.runs.length - MAX_RUNS);
  }

  _arm() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this._started) return;
    let delay = this.tickMs;
    const next = this._nextDueMs();
    if (next != null) delay = Math.min(delay, Math.max(0, next - this._nowMs()) + 5);
    delay = Math.max(10, delay);
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.tick();
      } catch (err) {
        this._reportError(err);
        this._arm();
      }
    }, delay);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _nextDueMs() {
    let min = null;
    for (const t of this.tasks.values()) {
      if (t.status !== 'active') continue;
      const ms = Date.parse(t.nextRunAt);
      if (Number.isNaN(ms)) continue;
      if (min == null || ms < min) min = ms;
    }
    return min;
  }

  // ---------------------------------------------------------------- internals

  _nowDate() {
    const n = this.now();
    const d = n instanceof Date ? new Date(n.getTime()) : new Date(Number(n));
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  _nowMs() {
    return this._nowDate().getTime();
  }

  _changed(action, task) {
    this._save();
    this._emitSafe('change', { action, task: clone(task) });
    this._arm();
  }

  _emitSafe(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      this._reportError(err);
    }
  }

  _reportError(err) {
    if (this.listenerCount('error') > 0) {
      try { this.emit('error', err); } catch { /* ignore */ }
    }
  }

  _load() {
    if (!this.file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.loadError = err;
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      this.loadError = err;
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
    const nowD = this._nowDate();
    for (const x of list) {
      if (!x || typeof x !== 'object' || !x.id) continue;
      let rec = null;
      try { rec = normalizeRecurrence(x.recurrence); } catch { rec = null; }
      const t = {
        id: String(x.id),
        title: trunc(String(x.title || 'Reminder'), MAX_TITLE),
        kind: KINDS.has(x.kind) ? x.kind : 'reminder',
        prompt: optText(x.prompt),
        notes: optText(x.notes),
        recurrence: rec,
        status: STATUSES.has(x.status) ? x.status : 'active',
        createdAt: x.createdAt || nowD.toISOString(),
        updatedAt: x.updatedAt || x.createdAt || nowD.toISOString(),
        nextRunAt: toDate(x.nextRunAt)?.toISOString() || null,
        lastRunAt: x.lastRunAt || null,
        runs: Array.isArray(x.runs) ? x.runs.slice(-MAX_RUNS) : [],
      };
      // A run still pending when the server stopped will never complete.
      for (const r of t.runs) if (r && r.ok === null) { r.ok = false; r.summary = 'Interrupted (server restarted)'; }
      if (!t.nextRunAt) {
        const n = rec ? firstOccurrence(rec, nowD) : null;
        if (n) t.nextRunAt = n.toISOString();
        else if (t.status === 'active') t.status = 'done';
      }
      this.tasks.set(t.id, t);
    }
  }

  _prune() {
    const inactive = [...this.tasks.values()].filter((t) => t.status !== 'active');
    if (inactive.length <= MAX_INACTIVE) return;
    inactive.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    for (const t of inactive.slice(0, inactive.length - MAX_INACTIVE)) this.tasks.delete(t.id);
  }

  _save() {
    if (!this.file) return;
    this._prune();
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ version: 1, savedAt: this._nowDate().toISOString(), tasks: [...this.tasks.values()] }, null, 2);
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastSaveError = null;
    } catch (err) {
      this.lastSaveError = err;
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      this._reportError(err);
    }
  }
}

export default TaskScheduler;
