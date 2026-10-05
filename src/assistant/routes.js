// HTTP surface of the Cairn desktop assistant: every /api/assistant/* route.
//
//   const assistant = createAssistant({ runtime });
//   await assistant.start();                       // scheduler + background-run monitor
//   if (await assistant.handle(req, res, url, { body })) return;   // false → not ours
//
// The assistant is always on: chat requests start *background runs* (they keep
// going when the bubble is closed or the SSE client disconnects), scheduled
// reminders / agent tasks fire from the TaskScheduler, and the global
// /api/assistant/events stream plus macOS notifications tell the user what
// happened (run_started / run_update / run_done, approvals, reminders).
//
// Guards (same as the engine, re-applied here so the module is safe on its own):
// Host must be loopback / the public base URL; Origin, when present, must equal
// the server origin (403); cross-site Sec-Fetch-Site is refused (403);
// POST/DELETE need Content-Type: application/json (415); bodies ≤ 1 MB (413).
// When src/server/app.js has already parsed the body, pass it as `{ body }`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as agentModule from './agent.js';
import * as conversationsModule from './conversations.js';
import * as approvalsModule from './approvals.js';
import * as schedulerModule from './scheduler.js';
import * as whenModule from './when.js';
import * as macosModule from './macos.js';
import { ShoppingList, readJsonFile, writeJsonAtomic } from './shopping.js';
import { claudeAvailable } from '../agent/claude.js';

export const BODY_LIMIT = 1024 * 1024;
const DRAIN_LIMIT = 16 * BODY_LIMIT;
export const HEARTBEAT_MS = 15_000;
export const PREFIX = '/api/assistant';
const MAX_WAIT_SEC = 60;
const MAX_MESSAGE = 20_000;
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const WRITE_METHODS = new Set(['POST', 'DELETE', 'PUT', 'PATCH']);
const TASK_KINDS = new Set(['reminder', 'agent']);
const RECURRENCE_EVERY = new Set(['minute', 'hour', 'day', 'week', 'weekday']);
const WEEKDAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const MAX_NOTIFICATIONS = 50;

export const DEFAULT_SETTINGS = Object.freeze({
  model: '',
  maxBudgetUsd: 2,
  // Runs start in ~/CairnWorkspace (created on demand) with the home folder added via --add-dir.
  workDir: agentModule.DEFAULT_WORKDIR || path.join(os.homedir(), 'CairnWorkspace'),
  // --setting-sources "": the user's ~/.claude/settings.json allow rules must not bypass Cairn's approvals.
  isolateClaudeSettings: true,
  allowBrowser: true,
  autoApproveBrowser: false,
  notifyWithMac: true,
  notifyOnComplete: true,
  maxConcurrentRuns: 3,
});

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function oneLine(value, max = 120) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalString(value, name, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (value.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  return value;
}

function requireString(value, name, max) {
  const s = optionalString(value, name, max);
  if (!s || !s.trim()) throw new HttpError(400, `${name} is required`);
  return s.trim();
}

function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  // Prefer the macOS module's parser (offset-less ISO = local wall-clock time).
  const viaMac = typeof macosModule.parseIsoLocal === 'function' ? macosModule.parseIsoLocal(value) : null;
  if (viaMac) return viaMac;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

export function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

// Read a JSON object body (≤ limit bytes). Oversized bodies are drained so the
// client can read the 413, but abusive senders are cut off.
export function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        if (size > DRAIN_LIMIT) {
          done(reject, new HttpError(413, 'Request body exceeds 1 MB'));
          req.destroy();
        }
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) return done(reject, new HttpError(413, 'Request body exceeds 1 MB'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done(resolve, {});
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return done(reject, new HttpError(400, 'Invalid JSON body'));
      }
      if (!isPlainObject(value)) return done(reject, new HttpError(400, 'JSON body must be an object'));
      done(resolve, value);
    });
    req.on('error', (err) => done(reject, new HttpError(400, `Request error: ${err.message}`)));
  });
}

// Server-Sent Events: `event: <type>` + `data: <json>`, heartbeat comments,
// cleanup on client disconnect.
export function openEventStream(req, res, { heartbeatMs = HEARTBEAT_MS, retryMs = 3000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  req.socket?.setNoDelay?.(true);
  res.write(`retry: ${retryMs}\n\n`);
  let closed = false;
  const closeHandlers = [];
  const timer = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, heartbeatMs);
  timer.unref?.();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const fn of closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        // one failing close handler must not block the rest
      }
    }
  }

  const stream = {
    get closed() {
      return closed;
    },
    send(event, data, { id } = {}) {
      if (closed || res.writableEnded || res.destroyed) return false;
      const payload = typeof data === 'string' ? data : JSON.stringify(data ?? null);
      let frame = '';
      if (id !== undefined && id !== null) frame += `id: ${String(id).replace(/[\r\n]+/g, ' ')}\n`;
      if (event) frame += `event: ${String(event).replace(/[\r\n]+/g, ' ')}\n`;
      for (const line of payload.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
      res.write(frame + '\n');
      return true;
    },
    onClose(fn) {
      if (closed) fn();
      else closeHandlers.push(fn);
      return stream;
    },
    close() {
      if (closed) return;
      cleanup();
      if (!res.writableEnded) res.end();
    },
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return stream;
}

function isLoopbackHost(host) {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
}

// Origin / cross-site / Host checks for every assistant route. Returns an
// HttpError or null.
function guardRequest(req, method, config) {
  const host = String(req.headers.host || '').toLowerCase();
  let publicHost = '';
  try {
    publicHost = new URL(config.publicBaseUrl).host.toLowerCase();
  } catch {
    publicHost = '';
  }
  if (host && !isLoopbackHost(host) && host !== publicHost) {
    return new HttpError(421, 'Misdirected request: unexpected Host header');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}` && !(publicHost && origin === `http://${publicHost}`)) {
    return new HttpError(403, 'Cross-origin request rejected');
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site' || (!WRITE_METHODS.has(method) && fetchSite === 'same-site')) {
    return new HttpError(403, 'Cross-site request rejected');
  }
  if (WRITE_METHODS.has(method)) {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return new HttpError(415, 'Content-Type must be application/json');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings (<dataDir>/assistant-settings.json)
// ---------------------------------------------------------------------------

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Validate a partial settings object. Returns the cleaned patch; throws HttpError(400).
export function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) throw new HttpError(400, 'Settings must be a JSON object');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'model': {
        const v = value === null ? '' : value;
        if (typeof v !== 'string' || v.length > 100 || !/^[A-Za-z0-9._:\-[\]/]*$/.test(v.trim())) {
          throw new HttpError(400, 'model must be a model name or alias such as "sonnet" (empty = engine default)');
        }
        out.model = v.trim();
        break;
      }
      case 'maxBudgetUsd':
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
          throw new HttpError(400, 'maxBudgetUsd must be a number between 0 and 100');
        }
        out.maxBudgetUsd = value;
        break;
      case 'workDir': {
        if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new HttpError(400, 'workDir must be a directory path');
        const dir = path.resolve(expandHome(value.trim()));
        let stat = null;
        try {
          if (dir === DEFAULT_SETTINGS.workDir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          stat = fs.statSync(dir);
        } catch {
          stat = null;
        }
        if (!stat?.isDirectory()) throw new HttpError(400, `workDir does not exist or is not a directory: ${dir}`);
        out.workDir = dir;
        break;
      }
      case 'allowBrowser':
      case 'autoApproveBrowser':
      case 'isolateClaudeSettings':
      case 'notifyWithMac':
      case 'notifyOnComplete':
        if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be a boolean`);
        out[key] = value;
        break;
      case 'maxConcurrentRuns':
        if (!Number.isInteger(value) || value < 1 || value > 10) throw new HttpError(400, 'maxConcurrentRuns must be a whole number between 1 and 10');
        out.maxConcurrentRuns = value;
        break;
      default:
        throw new HttpError(400, `Unknown setting: ${key}`);
    }
  }
  return out;
}

export function loadSettings(file) {
  const settings = { ...DEFAULT_SETTINGS };
  const saved = readJsonFile(file, null);
  if (isPlainObject(saved)) {
    // Apply each saved key on its own so one bad value never discards the rest.
    for (const [k, v] of Object.entries(saved)) {
      try {
        Object.assign(settings, validateSettingsPatch({ [k]: v }));
      } catch {
        // ignore invalid / unknown saved keys
      }
    }
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function validateRecurrence(value) {
  if (value === undefined || value === null || value === '' || value === false) return null;
  if (typeof whenModule.normalizeRecurrence === 'function') {
    try {
      return whenModule.normalizeRecurrence(value);
    } catch (err) {
      throw new HttpError(400, err.message || 'Invalid recurrence');
    }
  }
  if (!isPlainObject(value)) throw new HttpError(400, 'recurrence must be an object like {"every":"day","at":"08:00"}');
  const every = String(value.every || '');
  if (!RECURRENCE_EVERY.has(every)) throw new HttpError(400, `recurrence.every must be one of: ${[...RECURRENCE_EVERY].join(', ')}`);
  const out = { every };
  if (value.interval !== undefined && value.interval !== null) {
    if (!Number.isInteger(value.interval) || value.interval < 1 || value.interval > 1000) throw new HttpError(400, 'recurrence.interval must be a whole number ≥ 1');
    out.interval = value.interval;
  }
  if (value.at !== undefined && value.at !== null && value.at !== '') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value.at));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HttpError(400, 'recurrence.at must be HH:MM (24-hour local time)');
    out.at = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  if (value.days !== undefined && value.days !== null) {
    if (!Array.isArray(value.days) || value.days.some((d) => !WEEKDAYS.has(String(d).toLowerCase().slice(0, 3)))) {
      throw new HttpError(400, 'recurrence.days must be an array like ["mon","wed"]');
    }
    out.days = value.days.map((d) => String(d).toLowerCase().slice(0, 3));
  }
  return out;
}

function parseWhenText(text, now = new Date()) {
  if (typeof whenModule.parseWhen !== 'function') throw new HttpError(501, 'Natural-language time parsing is not available');
  try {
    return whenModule.parseWhen(text, now) || null;
  } catch {
    return null;
  }
}

// Turn a POST /tasks body into scheduler.add() input.
export function taskInputFromBody(body, now = new Date()) {
  const kind = body.kind === undefined || body.kind === null || body.kind === '' ? 'reminder' : String(body.kind);
  if (!TASK_KINDS.has(kind)) throw new HttpError(400, "kind must be 'reminder' or 'agent'");
  const text = optionalString(body.text, 'text', 2000);
  let title = optionalString(body.title, 'title', 300)?.trim() || '';
  let when = body.when;
  let recurrence = validateRecurrence(body.recurrence);

  if (text && text.trim() && (when === undefined || when === null || when === '')) {
    const parsed = parseWhenText(text.trim(), now);
    if (!parsed || !parsed.when) {
      throw new HttpError(400, `Could not work out when from "${oneLine(text, 80)}" — try e.g. "in 10 minutes", "tomorrow at 9am" or "every weekday at 8:30"`);
    }
    when = parsed.when;
    if (!recurrence && parsed.recurrence) recurrence = validateRecurrence(parsed.recurrence);
    if (!title) title = String(parsed.title || '').trim() || text.trim();
  } else if (!title && text) {
    title = text.trim();
  }

  const firstRun = whenModule.firstOccurrence || schedulerModule.nextOccurrence || whenModule.nextOccurrence;
  if ((when === undefined || when === null || when === '') && recurrence && typeof firstRun === 'function') {
    const next = firstRun(recurrence, now);
    if (next instanceof Date && !Number.isNaN(next.getTime())) when = next.toISOString();
  }
  if (when === undefined || when === null || when === '') throw new HttpError(400, 'when (ISO 8601) or text (e.g. "in 10 minutes") is required');
  const date = parseDate(typeof when === 'string' ? when : String(when));
  if (!date) throw new HttpError(400, `when must be an ISO 8601 date/time, got "${oneLine(when, 60)}"`);

  const prompt = optionalString(body.prompt, 'prompt', MAX_MESSAGE)?.trim() || '';
  if (!title) title = prompt ? oneLine(prompt, 60) : '';
  if (!title) throw new HttpError(400, 'title is required');
  const notes = optionalString(body.notes, 'notes', 4000) || '';
  return {
    title: title.slice(0, 300),
    kind,
    when: typeof when === 'string' ? when : date.toISOString(),
    recurrence: recurrence || null,
    prompt: kind === 'agent' ? prompt || title : prompt,
    notes,
  };
}

// ---------------------------------------------------------------------------
// createAssistant
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.runtime       engine runtime ({config, audit, ...})
 * @param {number} [opts.tickMs]      scheduler tick (default 5000)
 * @param {number} [opts.heartbeatMs] SSE heartbeat (default 15000)
 * @param {number} [opts.approvalTimeoutMs] (default 300000)
 * @param {number} [opts.approvalNotifyDelayMs] grace before the "needs your approval" notification (default 250)
 * Dependency overrides (tests): agent, approvals, conversations, scheduler, shopping, macos, now.
 */
export function createAssistant(opts = {}) {
  const { runtime } = opts;
  if (!runtime?.config) throw new Error('createAssistant requires {runtime} with a config');
  const config = runtime.config;
  const dataDir = config.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const mac = opts.macos || macosModule.default || macosModule;
  const nowFn = opts.now || (() => new Date());

  const settingsFile = path.join(dataDir, 'assistant-settings.json');
  const settings = loadSettings(settingsFile); // live object shared with the agent

  const conversations = opts.conversations || new conversationsModule.ConversationStore({ dir: path.join(dataDir, 'conversations') });
  const approvals = opts.approvals || new approvalsModule.ApprovalQueue({ timeoutMs: opts.approvalTimeoutMs ?? 300_000 });
  const scheduler =
    opts.scheduler ||
    new schedulerModule.TaskScheduler({ file: path.join(dataDir, 'tasks.json'), tickMs: opts.tickMs ?? 5000, ...(opts.now ? { now: opts.now } : {}) });
  const shopping = opts.shopping || new ShoppingList({ file: path.join(dataDir, 'shopping.json') });
  const agent =
    opts.agent ||
    new agentModule.AssistantAgent({ runtime, conversations, approvals, getApiUrl: () => runtime.config.publicBaseUrl, settings });

  const bus = new EventEmitter(); // in-process mirror of the global SSE stream
  bus.setMaxListeners(100);
  const clients = new Set(); // open /api/assistant/events streams
  const notifications = []; // recent macOS notifications (debugging / tests)
  const cleanups = [];
  let started = false;
  let stopped = false;

  // ---------------- broadcasting & notifications ----------------

  function broadcast(type, data = {}) {
    const payload = { type, ...data, at: new Date().toISOString() };
    for (const c of [...clients]) {
      if (c.closed) clients.delete(c);
      else c.send(type, payload);
    }
    bus.emit('event', payload);
    bus.emit(type, payload);
    return payload;
  }

  function notify({ title, message, sound = true, subtitle } = {}) {
    const entry = { title: oneLine(title, 200), message: oneLine(message, 400), at: new Date().toISOString(), sent: false };
    notifications.push(entry);
    if (notifications.length > MAX_NOTIFICATIONS) notifications.splice(0, notifications.length - MAX_NOTIFICATIONS);
    if (settings.notifyWithMac === false || typeof mac.notify !== 'function') return Promise.resolve({ ok: false, skipped: true });
    entry.sent = true;
    return Promise.resolve()
      .then(() => mac.notify({ title: entry.title, message: entry.message, sound, ...(subtitle ? { subtitle } : {}) }))
      .then((r) => {
        entry.result = r;
        return r;
      })
      .catch((err) => ({ ok: false, error: err.message }));
  }

  function audit(entry) {
    try {
      runtime.audit?.record?.({ kind: 'agent', mode: 'assistant', ...entry });
    } catch {
      // auditing must never break a request
    }
  }

  // ---------------- background-run monitor ----------------
  // The agent emits run_started / run_update (state changes) / run_done with a
  // run row, plus run_event for every streamed event. We mirror those onto the
  // global stream so the Activity tab and the desktop shell stay live even when
  // no chat SSE is open, and notify on completion.

  const PROGRESS_TYPES = new Set(['tool', 'tool_result', 'status']);
  const progressAt = new Map(); // runId -> ms of last progress broadcast (throttle)

  function listRuns(limit = 50) {
    try {
      return agent.listRuns?.({ limit }) || [];
    } catch {
      return [];
    }
  }

  function runRow(runId) {
    const full = agent.getRun?.(runId);
    if (!full) return null;
    const { events, ...row } = full;
    return row;
  }

  function runResultText(run) {
    if (run.text) return String(run.text);
    const events = agent.getRun?.(run.runId)?.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'result' && events[i].text) return String(events[i].text);
    }
    const text = events.filter((e) => e?.type === 'text').map((e) => e.text || '').join('');
    if (text.trim()) return text;
    return String(run.error || run.lastEvent || '');
  }

  function onRunDone(run) {
    progressAt.delete(run.runId);
    const text = runResultText(run);
    broadcast('run_done', { run, text: text.slice(0, 4000) });
    // Scheduled (unattended) runs are reported through task_result instead.
    if (run.state === 'cancelled' || run.unattended) return;
    if (settings.notifyOnComplete === false) return;
    const title = oneLine(run.title || 'your task', 80);
    if (run.state === 'done') notify({ title: `Cairn finished: ${title}`, message: oneLine(text, 120) || 'Done.' });
    else notify({ title: `Cairn couldn't finish: ${title}`, message: oneLine(run.error || text, 120) || 'The run failed.' });
  }

  const agentListeners = {
    run_started: (run) => broadcast('run_started', { run }),
    run_update: (run) => broadcast('run_update', { run }),
    run_done: (run) => onRunDone(run),
    // Progress ("last step") updates for the Activity tab, at most once a second per run.
    run_event: ({ runId, event } = {}) => {
      if (!event || !PROGRESS_TYPES.has(event.type)) return;
      const now = Date.now();
      if (now - (progressAt.get(runId) || 0) < 1000) return;
      progressAt.set(runId, now);
      const run = runRow(runId);
      if (run && !TERMINAL.has(run.state)) broadcast('run_update', { run, progress: true });
    },
  };
  if (typeof agent.on === 'function') {
    for (const [name, fn] of Object.entries(agentListeners)) agent.on(name, fn);
    cleanups.push(() => {
      for (const [name, fn] of Object.entries(agentListeners)) agent.off(name, fn);
    });
  }

  // ---------------- approvals ----------------

  const approvalNotifyDelayMs = opts.approvalNotifyDelayMs ?? 250;
  const onApprovalRequest = (approval) => {
    broadcast('approval', { approval });
    // Short grace period: "always allow" approvals are auto-resolved by the agent
    // right away and must not pop a notification.
    const t = setTimeout(() => {
      const rec = approval?.id ? approvals.get(approval.id) : null;
      if (stopped || (rec && rec.status && rec.status !== 'pending')) return;
      notify({ title: 'Cairn needs your approval', message: approval?.summary || approval?.toolName || 'A tool call is waiting for you' });
    }, approvalNotifyDelayMs);
    t.unref?.();
  };
  const onApprovalResolved = (rec) => {
    const decision = rec?.decision || {};
    broadcast('approval_resolved', { id: rec?.id, allow: decision.allow === true, reason: rec?.reason, runId: rec?.runId ?? null, conversationId: rec?.conversationId ?? null });
  };
  if (typeof approvals.on === 'function') {
    approvals.on('request', onApprovalRequest);
    approvals.on('resolved', onApprovalResolved);
    cleanups.push(() => {
      approvals.off('request', onApprovalRequest);
      approvals.off('resolved', onApprovalResolved);
    });
  }

  function waitForApproval(id, timeoutMs, res) {
    const rec = approvals.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.status && rec.status !== 'pending') return Promise.resolve({ decided: true, decision: rec.decision });
    if (typeof approvals.wait === 'function') return approvals.wait(id, timeoutMs);
    // Fallback for queues without wait(): watch the 'resolved' event.
    return new Promise((resolve) => {
      const finish = (v) => {
        clearTimeout(timer);
        approvals.off?.('resolved', onResolved);
        resolve(v);
      };
      const onResolved = (r) => {
        if (r?.id === id) finish({ decided: true, decision: r.decision });
      };
      const timer = setTimeout(() => finish({ decided: false }), timeoutMs);
      approvals.on?.('resolved', onResolved);
      res.on('close', () => finish({ decided: false }));
    });
  }

  // ---------------- scheduler ----------------

  async function onDue(task) {
    if (!task || stopped) return;
    try {
      if (task.kind === 'agent') {
        broadcast('task_started', { task });
        let out;
        try {
          out = await agent.runOnce(task.prompt || task.title, { unattended: true, title: task.title, taskId: task.id });
        } catch (err) {
          out = { ok: false, text: `Error: ${err.message}` };
        }
        const ok = Boolean(out?.ok);
        const text = String(out?.text ?? '');
        const summary = oneLine(text, 200) || (ok ? 'Done' : 'Failed');
        try {
          scheduler.markRun?.(task.id, { ok, summary });
        } catch {
          // task may have been cancelled meanwhile
        }
        notify({ title: `${ok ? 'Cairn finished' : 'Cairn task failed'}: ${oneLine(task.title, 80)}`, message: oneLine(text, 120) || summary });
        broadcast('task_result', { task: scheduler.get?.(task.id) || task, text: text.slice(0, 8000), ok, costUsd: out?.costUsd ?? null });
        audit({ event: 'task_result', taskId: task.id, title: task.title, ok, costUsd: out?.costUsd ?? null });
      } else {
        notify({ title: 'Cairn reminder', message: task.notes ? `${task.title} — ${task.notes}` : task.title });
        broadcast('reminder', { task });
        audit({ event: 'reminder', taskId: task.id, title: task.title });
      }
    } catch (err) {
      broadcast('task_error', { task, message: err.message });
    }
  }
  const onDueListener = (task) => {
    onDue(task);
  };
  // Every task mutation (API, MCP tool, firing) → one 'tasks_changed' event for the Tasks tab.
  const onTaskChange = (change) => broadcast('tasks_changed', { action: change?.action, task: change?.task ?? null });
  if (typeof scheduler.on === 'function') {
    scheduler.on('due', onDueListener);
    scheduler.on('change', onTaskChange);
    cleanups.push(() => {
      scheduler.off('due', onDueListener);
      scheduler.off('change', onTaskChange);
    });
  }

  function taskList({ includeDone = false } = {}) {
    try {
      return scheduler.list({ includeDone }) || [];
    } catch {
      return [];
    }
  }

  function nextTaskAt() {
    if (typeof scheduler.nextTaskAt === 'function') {
      try {
        return scheduler.nextTaskAt();
      } catch {
        // fall through to the list scan
      }
    }
    let best = null;
    for (const t of taskList()) {
      if (t.status && t.status !== 'active') continue;
      if (t.nextRunAt && (!best || t.nextRunAt < best)) best = t.nextRunAt;
    }
    return best;
  }

  // ---------------- health ----------------

  async function health() {
    let claude;
    try {
      claude = await claudeAvailable(config);
    } catch (err) {
      claude = { available: false, bin: config.agent?.claudeBin, error: err.message };
    }
    let counts = null;
    try {
      counts = agent.counts?.() || null;
    } catch {
      counts = null;
    }
    if (!counts) {
      const runs = listRuns(50);
      const count = (s) => runs.filter((r) => r.state === s).length;
      counts = { runningRuns: count('running') + count('waiting_approval'), queuedRuns: count('queued'), waitingApproval: count('waiting_approval') };
    }
    const active = taskList().filter((t) => !t.status || t.status === 'active').length;
    return {
      ok: true,
      claude,
      scheduler: { active, running: started && !stopped },
      pendingApprovals: approvals.pending().length,
      runningRuns: counts.runningRuns ?? 0,
      queuedRuns: counts.queuedRuns ?? 0,
      waitingApprovalRuns: counts.waitingApproval ?? 0,
      nextTaskAt: nextTaskAt(),
      shoppingItems: shopping.list({ includeDone: false }).length,
      settings: { notifyWithMac: settings.notifyWithMac, notifyOnComplete: settings.notifyOnComplete, allowBrowser: settings.allowBrowser },
    };
  }

  // ---------------- routes ----------------

  const routes = [];
  function route(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${PREFIX}${source}$`), keys, handler });
  }

  function requireRun(runId) {
    const run = agent.getRun?.(runId);
    if (!run) throw new HttpError(404, `Unknown run: ${runId}`);
    return run;
  }

  // Chat → background run
  route('POST', '/chat', async (ctx) => {
    const message = requireString(ctx.body.message, 'message', MAX_MESSAGE);
    const conversationId = optionalString(ctx.body.conversationId, 'conversationId', 100) || undefined;
    if (conversationId && !conversations.get(conversationId)) throw new HttpError(404, `Unknown conversation: ${conversationId}`);
    // A background run: it keeps going if this client (or the bubble) goes away.
    const out = await agent.startRun({ conversationId, message });
    ctx.status = 202;
    return { runId: out.runId, conversationId: out.conversationId, background: true };
  });

  route('GET', '/runs', (ctx) => ({ runs: listRuns(clampInt(ctx.query.limit, 30, 1, 50)) }));

  route('GET', '/runs/:runId', (ctx) => {
    const run = requireRun(ctx.params.runId);
    const summary = listRuns(50).find((r) => r.runId === ctx.params.runId) || {};
    const merged = { ...summary, ...run };
    return { ...merged, run: merged };
  });

  route('GET', '/runs/:runId/events', (ctx) => {
    const { runId } = ctx.params;
    requireRun(runId);
    if (typeof agent.subscribe !== 'function') throw new HttpError(501, 'Run streaming is not available');
    const lastId = Number.parseInt(ctx.req.headers['last-event-id'] ?? ctx.query.lastEventId ?? '', 10);
    const stream = openEventStream(ctx.req, ctx.res, { heartbeatMs });
    let seq = 0;
    let unsub = null;
    let ended = false;
    const onEvent = (ev) => {
      if (stream.closed || !ev) return;
      const id = seq++;
      const type = String(ev.type || 'message');
      // Skip what a reconnecting client already has — but always deliver `done`.
      if (Number.isFinite(lastId) && id <= lastId && type !== 'done') return;
      stream.send(type, ev, { id });
      if (type === 'done') {
        ended = true;
        setImmediate(() => stream.close());
      }
    };
    stream.onClose(() => {
      if (typeof unsub === 'function') unsub();
      unsub = null;
    });
    unsub = agent.subscribe(runId, onEvent);
    if ((ended || stream.closed) && typeof unsub === 'function') {
      unsub();
      unsub = null;
    }
    return undefined; // streaming
  });

  route('POST', '/runs/:runId/cancel', (ctx) => {
    requireRun(ctx.params.runId);
    const result = agent.cancel(ctx.params.runId);
    try {
      approvals.denyRun?.(ctx.params.runId, 'Run cancelled by the user');
    } catch {
      // ignore
    }
    return { ok: result !== false };
  });

  // Conversations
  route('GET', '/conversations', () => ({ conversations: conversations.list() }));
  route('GET', '/conversations/:id', (ctx) => {
    const conv = conversations.get(ctx.params.id);
    if (!conv) throw new HttpError(404, `Unknown conversation: ${ctx.params.id}`);
    return { ...conv, conversation: conv };
  });
  route('DELETE', '/conversations/:id', (ctx) => {
    if (!conversations.get(ctx.params.id)) throw new HttpError(404, `Unknown conversation: ${ctx.params.id}`);
    conversations.remove(ctx.params.id);
    return { ok: true };
  });

  // Approvals
  route('GET', '/approvals', (ctx) => ({ pending: approvals.pending(ctx.query.runId ? { runId: ctx.query.runId } : {}) }));
  route('POST', '/approvals', (ctx) => {
    const toolName = requireString(ctx.body.toolName ?? ctx.body.tool_name, 'toolName', 200);
    const input = ctx.body.input === undefined ? {} : ctx.body.input;
    const conversationId = optionalString(ctx.body.conversationId, 'conversationId', 100) || null;
    const runId = optionalString(ctx.body.runId, 'runId', 100) || null;
    const { id, promise } = approvals.request({ toolName, input, conversationId, runId });
    promise?.catch?.(() => {});
    audit({ event: 'approval_requested', approvalId: id, toolName, runId, conversationId });
    return { id };
  });
  route('GET', '/approvals/:id', (ctx) => {
    const rec = approvals.get(ctx.params.id);
    if (!rec) throw new HttpError(404, `Unknown approval: ${ctx.params.id}`);
    return { approval: rec };
  });
  route('GET', '/approvals/:id/wait', async (ctx) => {
    const timeoutSec = clampInt(ctx.query.timeout, MAX_WAIT_SEC, 0, MAX_WAIT_SEC);
    const out = await waitForApproval(ctx.params.id, timeoutSec * 1000, ctx.res);
    if (!out) throw new HttpError(404, `Unknown approval: ${ctx.params.id}`, { decided: false });
    if (ctx.res.destroyed || ctx.res.writableEnded) return undefined;
    return out.decided ? { decided: true, decision: out.decision } : { decided: false };
  });
  route('POST', '/approvals/:id', (ctx) => {
    const rec = approvals.get(ctx.params.id);
    if (!rec) throw new HttpError(404, `Unknown approval: ${ctx.params.id}`);
    const allow = ctx.body.allow === true;
    const always = ctx.body.always === true;
    const decision = { allow };
    const message = optionalString(ctx.body.message, 'message', 2000);
    if (message) decision.message = message;
    if (always) decision.always = true;
    if (allow && isPlainObject(ctx.body.updatedInput)) decision.updatedInput = ctx.body.updatedInput;
    if (!approvals.resolve(ctx.params.id, decision)) throw new HttpError(409, 'This approval was already decided');
    let rememberedFor = null;
    if (allow && always && rec.conversationId && rec.toolName) {
      if (typeof conversations.addAllowAlways === 'function') {
        if (conversations.addAllowAlways(rec.conversationId, rec.toolName)) rememberedFor = rec.conversationId;
      }
    }
    audit({ event: 'approval_decided', approvalId: rec.id, toolName: rec.toolName, allow, always, runId: rec.runId });
    return { ok: true, ...(rememberedFor ? { alwaysAllowed: rec.toolName } : {}) };
  });

  // Tasks
  route('GET', '/tasks', (ctx) => {
    const includeDone = ['1', 'true', 'yes'].includes(String(ctx.query.includeDone ?? ctx.query.all ?? '').toLowerCase());
    return { tasks: taskList({ includeDone }) };
  });
  route('POST', '/tasks/parse', (ctx) => {
    const text = requireString(ctx.body.text, 'text', 2000);
    const parsed = parseWhenText(text, nowFn());
    if (!parsed) return { ok: false, parsed: null, error: 'Could not work out a time from that text' };
    return { ok: true, ...parsed, parsed };
  });
  route('POST', '/tasks', (ctx) => {
    const input = taskInputFromBody(ctx.body, nowFn());
    let task;
    try {
      task = scheduler.add(input);
    } catch (err) {
      throw new HttpError(400, err.message || 'Could not schedule the task');
    }
    audit({ event: 'task_added', taskId: task?.id, title: task?.title, taskKind: task?.kind, nextRunAt: task?.nextRunAt });
    ctx.status = 201;
    return { task };
  });
  route('GET', '/tasks/:id', (ctx) => {
    const task = scheduler.get(ctx.params.id);
    if (!task) throw new HttpError(404, `Unknown task: ${ctx.params.id}`);
    return { task };
  });
  route('POST', '/tasks/:id', (ctx) => {
    if (!scheduler.get(ctx.params.id)) throw new HttpError(404, `Unknown task: ${ctx.params.id}`);
    if (typeof scheduler.update !== 'function') throw new HttpError(501, 'Task updates are not available');
    const patch = {};
    for (const k of ['title', 'notes', 'prompt']) {
      const v = optionalString(ctx.body[k], k, k === 'prompt' ? MAX_MESSAGE : 4000);
      if (v !== undefined) patch[k] = v;
    }
    if ('recurrence' in ctx.body) patch.recurrence = validateRecurrence(ctx.body.recurrence);
    if ('when' in ctx.body) {
      const d = parseDate(ctx.body.when);
      if (!d) throw new HttpError(400, 'when must be an ISO 8601 date/time');
      patch.when = ctx.body.when;
    }
    let task;
    try {
      task = scheduler.update(ctx.params.id, patch);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return { task };
  });
  route('DELETE', '/tasks/:id', (ctx) => {
    if (!scheduler.get(ctx.params.id)) throw new HttpError(404, `Unknown task: ${ctx.params.id}`);
    const out = scheduler.cancel(ctx.params.id);
    const task = (out && typeof out === 'object' ? out : null) || scheduler.get(ctx.params.id);
    return { ok: out !== false, task };
  });
  route('POST', '/tasks/:id/run', async (ctx) => {
    const task = scheduler.get(ctx.params.id);
    if (!task) throw new HttpError(404, `Unknown task: ${ctx.params.id}`);
    if (typeof scheduler.runNow === 'function') await scheduler.runNow(ctx.params.id);
    else onDue(task);
    return { ok: true, task: scheduler.get(ctx.params.id) || task };
  });

  // macOS actions (proxied by the assistant MCP tools)
  function macResult(ctx, r) {
    if (!r || r.ok === false) {
      ctx.status = 502;
      return { ok: false, ...(r || {}), error: r?.error || 'The macOS action failed' };
    }
    return r;
  }
  route('POST', '/notify', async (ctx) => {
    const title = optionalString(ctx.body.title, 'title', 200)?.trim() || 'Cairn';
    const message = requireString(ctx.body.message, 'message', 1000);
    broadcast('notification', { title, message });
    if (typeof mac.notify !== 'function') return { ok: false, error: 'Notifications are not available' };
    const r = await mac.notify({ title, message, sound: ctx.body.sound !== false });
    return macResult(ctx, r);
  });
  route('POST', '/mac/reminder', async (ctx) => {
    const title = requireString(ctx.body.title, 'title', 500);
    const r = await mac.addReminder({
      title,
      due: optionalString(ctx.body.due, 'due', 64),
      list: optionalString(ctx.body.list, 'list', 200),
      notes: optionalString(ctx.body.notes, 'notes', 4000),
    });
    if (r?.ok === false && /invalid|required/i.test(r.error || '')) throw new HttpError(400, r.error);
    audit({ event: 'mac_reminder', title, ok: r?.ok !== false, dryRun: Boolean(r?.dryRun) });
    return macResult(ctx, r);
  });
  route('POST', '/mac/calendar', async (ctx) => {
    const title = requireString(ctx.body.title, 'title', 500);
    const start = requireString(ctx.body.start, 'start', 64);
    const r = await mac.addCalendarEvent({
      title,
      start,
      end: optionalString(ctx.body.end, 'end', 64),
      calendar: optionalString(ctx.body.calendar, 'calendar', 200),
      location: optionalString(ctx.body.location, 'location', 500),
      notes: optionalString(ctx.body.notes, 'notes', 4000),
    });
    if (r?.ok === false && /invalid|required|must be after/i.test(r.error || '')) throw new HttpError(400, r.error);
    audit({ event: 'mac_calendar', title, ok: r?.ok !== false, dryRun: Boolean(r?.dryRun) });
    return macResult(ctx, r);
  });
  route('POST', '/open', async (ctx) => {
    if (ctx.body.url !== undefined) {
      const url = requireString(ctx.body.url, 'url', 4000);
      let u = null;
      try {
        u = new URL(url);
      } catch {
        u = null;
      }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new HttpError(400, 'Only absolute http(s) URLs can be opened');
      const r = await mac.openUrl(url);
      audit({ event: 'open_url', url: u.href, ok: r?.ok !== false });
      return macResult(ctx, r);
    }
    if (ctx.body.app !== undefined) {
      const app = requireString(ctx.body.app, 'app', 120);
      if (app.startsWith('-') || /[\u0000-\u001f\u007f]/.test(app)) throw new HttpError(400, 'A plain application name is required');
      const r = await mac.openApp(app);
      audit({ event: 'open_app', app, ok: r?.ok !== false });
      return macResult(ctx, r);
    }
    throw new HttpError(400, 'Provide {url} or {app}');
  });
  route('POST', '/clipboard', async (ctx) => {
    const op = ctx.body.op;
    if (op === 'read') return macResult(ctx, await mac.clipboardRead());
    if (op === 'write') {
      if (typeof ctx.body.text !== 'string') throw new HttpError(400, 'text must be a string');
      return macResult(ctx, await mac.clipboardWrite(ctx.body.text));
    }
    throw new HttpError(400, "op must be 'read' or 'write'");
  });

  // Shopping list
  const shoppingError = (err) => (err?.status ? new HttpError(err.status, err.message) : err);
  route('GET', '/shopping', (ctx) => ({ items: shopping.list({ includeDone: ctx.query.includeDone !== 'false' }) }));
  route('POST', '/shopping', (ctx) => {
    let item;
    try {
      item = shopping.add(ctx.body);
    } catch (err) {
      throw shoppingError(err);
    }
    broadcast('shopping_changed', { action: 'added', item });
    return { item };
  });
  route('POST', '/shopping/:id', (ctx) => {
    let item;
    try {
      item = shopping.update(ctx.params.id, ctx.body);
    } catch (err) {
      throw shoppingError(err);
    }
    if (!item) throw new HttpError(404, `Unknown shopping item: ${ctx.params.id}`);
    broadcast('shopping_changed', { action: 'updated', item });
    return { item };
  });
  route('DELETE', '/shopping/:id', (ctx) => {
    if (!shopping.remove(ctx.params.id)) throw new HttpError(404, `Unknown shopping item: ${ctx.params.id}`);
    broadcast('shopping_changed', { action: 'removed', id: ctx.params.id });
    return { ok: true };
  });

  // Settings
  const settingsSnapshot = () => ({ ...settings });
  route('GET', '/settings', () => {
    const s = settingsSnapshot();
    return { ...s, settings: s, defaults: { ...DEFAULT_SETTINGS }, engineModel: config.agent?.model ?? null };
  });
  route('POST', '/settings', (ctx) => {
    const patch = validateSettingsPatch(isPlainObject(ctx.body.settings) ? ctx.body.settings : ctx.body);
    Object.assign(settings, patch); // mutate in place: the agent reads settings at use time
    writeJsonAtomic(settingsFile, settingsSnapshot());
    const s = settingsSnapshot();
    broadcast('settings_changed', { settings: s });
    return { ...s, settings: s };
  });

  // Global event stream
  route('GET', '/events', (ctx) => {
    const stream = openEventStream(ctx.req, ctx.res, { heartbeatMs });
    clients.add(stream);
    stream.onClose(() => clients.delete(stream));
    stream.send('hello', { type: 'hello', pendingApprovals: approvals.pending(), runs: listRuns(10), at: new Date().toISOString() });
    return undefined;
  });

  route('GET', '/health', () => health());

  // ---------------- handle ----------------

  async function handle(req, res, url, options = {}) {
    const rawPath = url?.pathname || '';
    const pathname = rawPath.replace(/\/+$/, '') || '/';
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    const upper = String(options.method || req.method || 'GET').toUpperCase();
    const method = upper === 'HEAD' ? 'GET' : upper;
    try {
      const blocked = guardRequest(req, method, config);
      if (blocked) {
        if (WRITE_METHODS.has(method) && options.body === undefined && !req.readableEnded) req.resume();
        sendJson(res, blocked.status, { error: blocked.message }, WRITE_METHODS.has(method) ? { Connection: 'close' } : {});
        return true;
      }
      let body = {};
      if (WRITE_METHODS.has(method)) {
        if (options.body !== undefined && options.body !== null) body = options.body;
        else if (!req.readableEnded) body = await readJson(req);
        if (!isPlainObject(body)) throw new HttpError(400, 'JSON body must be an object');
      }
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        let params;
        try {
          params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        } catch {
          throw new HttpError(400, 'Malformed URL path');
        }
        const ctx = { req, res, url, method, body, params, query: Object.fromEntries(url.searchParams), status: 200 };
        const out = await r.handler(ctx);
        if (out !== undefined && !res.headersSent && !res.destroyed) sendJson(res, ctx.status || 200, out);
        return true;
      }
      if (pathMatched) {
        const allowed = [...new Set(routes.filter((r) => r.re.test(pathname)).map((r) => r.method))].join(', ');
        sendJson(res, 405, { error: `Method ${method} not allowed` }, { Allow: allowed });
        return true;
      }
      sendJson(res, 404, { error: `Not found: ${rawPath}` });
      return true;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : Number.isInteger(err?.status) ? err.status : 500;
      if (status >= 500) console.error('[cairn assistant] request failed:', req.method, rawPath, err);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else if (!res.destroyed) {
        sendJson(res, status, { error: err.message || 'Internal server error', ...(err.extra || {}) }, status === 413 ? { Connection: 'close' } : {});
      }
      return true;
    }
  }

  // ---------------- lifecycle ----------------

  async function start() {
    if (started || stopped) return;
    started = true;
    if (typeof scheduler.load === 'function') await scheduler.load();
    await scheduler.start?.();
    audit({ event: 'assistant_started' });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      await scheduler.stop?.();
    } catch {
      // ignore
    }
    for (const c of [...clients]) c.close();
    clients.clear();
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    try {
      await (agent.close?.() ?? agent.shutdown?.());
    } catch {
      // ignore
    }
    try {
      approvals.close?.();
    } catch {
      // ignore
    }
  }

  return {
    handle,
    agent,
    approvals,
    scheduler,
    conversations,
    shopping,
    settings,
    events: bus,
    notifications,
    broadcast,
    notify,
    health,
    listRuns,
    start,
    stop,
    get started() {
      return started && !stopped;
    },
  };
}

// ---------------------------------------------------------------------------
// One assistant per runtime (for src/server/api.js and bin/cairn.js)
// ---------------------------------------------------------------------------

const perRuntime = new WeakMap();

// Lazily create (and start, so reminders fire even before the first request)
// the assistant for `runtime`.
export function assistantFor(runtime, opts = {}) {
  let a = perRuntime.get(runtime);
  if (!a) {
    a = createAssistant({ runtime, ...opts });
    perRuntime.set(runtime, a);
    if (opts.start !== false) {
      a.start().catch((err) => console.error('[cairn assistant] failed to start:', err));
    }
  }
  return a;
}

export async function closeAssistant(runtime) {
  const a = perRuntime.get(runtime);
  if (!a) return;
  perRuntime.delete(runtime);
  await a.stop();
}

// Drop-in for src/server/api.js handleApi(ctx): body already parsed by app.js.
export function handleAssistantApi(ctx) {
  return assistantFor(ctx.runtime).handle(ctx.req, ctx.res, ctx.url, { body: ctx.body ?? undefined, method: ctx.method });
}
