// Human-in-the-loop approvals. The Claude CLI is started with
// --permission-prompt-tool mcp__assistant__approval_prompt; that MCP tool POSTs
// here (via /api/assistant/approvals) and long-polls until the user clicks
// Approve / Deny / Always allow in the bubble, or the request times out.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 300_000;
const KEEP_RESOLVED = 200;
export const TIMEOUT_MESSAGE = 'No response from user (timed out)';

function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function compactJson(v, max = 120) {
  let s;
  try {
    s = JSON.stringify(v ?? {});
  } catch {
    s = String(v);
  }
  return oneLine(s === '{}' ? '' : s, max);
}

const q = (s, max = 80) => `"${oneLine(s, max)}"`;

// One-line human description of a tool call, e.g. `Run shell command: ls -la ~/Downloads`.
export function summarizeToolCall(toolName, input = {}) {
  const name = String(toolName || 'tool');
  const i = input && typeof input === 'object' ? input : {};
  const path = i.file_path || i.path || i.notebook_path;
  switch (name) {
    case 'Bash':
      return `Run shell command: ${oneLine(i.command, 200)}`;
    case 'Write':
      return `Write file: ${path}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit file: ${path}`;
    case 'NotebookEdit':
      return `Edit notebook: ${path}`;
    case 'Read':
      return `Read file: ${path}`;
    case 'Glob':
      return `Find files: ${oneLine(i.pattern)}${i.path ? ` in ${i.path}` : ''}`;
    case 'Grep':
      return `Search files for ${q(i.pattern)}${i.path ? ` in ${i.path}` : ''}`;
    case 'WebSearch':
      return `Search the web: ${oneLine(i.query)}`;
    case 'WebFetch':
      return `Fetch web page: ${oneLine(i.url)}`;
    case 'Task':
    case 'Agent':
      return `Start a sub-agent: ${oneLine(i.description || i.prompt, 120)}`;
    default:
      break;
  }
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!m) return `Use tool ${name}${compactJson(i) ? `: ${compactJson(i)}` : ''}`;
  const [, server, tool] = m;
  if (server === 'playwright') {
    const target = i.element || i.ref || '';
    switch (tool) {
      case 'browser_click':
        return `Click ${q(target || 'element')} in browser`;
      case 'browser_double_click':
        return `Double-click ${q(target || 'element')} in browser`;
      case 'browser_type':
        return `Type ${q(i.text, 60)} into ${q(target || 'field')} in browser${i.submit ? ' and submit' : ''}`;
      case 'browser_fill_form': {
        const n = Array.isArray(i.fields) ? i.fields.length : 0;
        const names = Array.isArray(i.fields) ? i.fields.map((f) => f?.name).filter(Boolean).slice(0, 4).join(', ') : '';
        return `Fill form in browser (${n} field${n === 1 ? '' : 's'}${names ? `: ${names}` : ''})`;
      }
      case 'browser_select_option':
        return `Select ${q([].concat(i.values ?? []).join(', '))} in ${q(target || 'dropdown')} in browser`;
      case 'browser_navigate':
        return `Open ${oneLine(i.url)} in browser`;
      case 'browser_navigate_back':
        return 'Go back in browser';
      case 'browser_press_key':
        return `Press ${oneLine(i.key)} in browser`;
      case 'browser_hover':
        return `Hover ${q(target || 'element')} in browser`;
      case 'browser_drag':
        return `Drag ${q(i.startElement)} to ${q(i.endElement)} in browser`;
      case 'browser_file_upload':
        return `Upload file(s) in browser: ${oneLine([].concat(i.paths ?? []).join(', '))}`;
      case 'browser_evaluate':
      case 'browser_run_code':
      case 'browser_run_code_unsafe':
        return `Run JavaScript in browser${i.function || i.code ? `: ${oneLine(i.function || i.code, 100)}` : ''}`;
      case 'browser_handle_dialog':
        return `${i.accept ? 'Accept' : 'Dismiss'} browser dialog`;
      case 'browser_close':
        return 'Close the browser page';
      case 'browser_tabs':
        return `Browser tabs: ${oneLine(i.action || 'list')}`;
      default:
        return `Browser: ${tool.replace(/^browser_/, '').replace(/_/g, ' ')}${compactJson(i) ? ` ${compactJson(i, 100)}` : ''}`;
    }
  }
  if (server === 'assistant') {
    switch (tool) {
      case 'clipboard_read':
        return 'Read your clipboard';
      case 'clipboard_write':
        return `Copy to clipboard: ${q(i.text, 80)}`;
      case 'open_app':
        return `Open app: ${oneLine(i.name)}`;
      case 'open_url':
        return `Open URL: ${oneLine(i.url)}`;
      case 'schedule_task':
        return `Schedule ${q(i.title)} at ${oneLine(i.when)}${i.recurrence ? ' (recurring)' : ''}`;
      case 'cancel_task':
        return `Cancel scheduled task ${oneLine(i.id)}`;
      case 'notify':
        return `Show notification: ${q(i.title)}`;
      case 'apple_reminder':
        return `Add to Reminders: ${q(i.title)}${i.due ? ` due ${oneLine(i.due)}` : ''}`;
      case 'calendar_event':
        return `Add calendar event: ${q(i.title)} at ${oneLine(i.start)}`;
      case 'shopping_list_add':
        return `Add to shopping list: ${q(i.item)}`;
      case 'shopping_list_remove':
        return `Remove from shopping list: ${oneLine(i.id)}`;
      default:
        break;
    }
  }
  if (server === 'cairn') {
    if (tool === 'crawl_site') return `Crawl site: ${oneLine(i.url || [].concat(i.seeds ?? []).join(', '))}`;
    if (tool === 'fetch_page') return `Fetch page: ${oneLine(i.url)}`;
    if (tool === 'search_index') return `Search Cairn index: ${oneLine(i.query)}`;
  }
  const args = compactJson(i, 100);
  return `Use ${server} tool ${tool.replace(/_/g, ' ')}${args ? `: ${args}` : ''}`;
}

function normalizeDecision(decision) {
  const d = decision && typeof decision === 'object' ? decision : { allow: Boolean(decision) };
  const out = { allow: d.allow === true || d.allow === 'true' };
  if (d.updatedInput && typeof d.updatedInput === 'object') out.updatedInput = d.updatedInput;
  if (d.message !== undefined && d.message !== null && d.message !== '') out.message = String(d.message);
  if (!out.allow && !out.message) out.message = 'The user denied this action';
  if (d.always) out.always = true;
  return out;
}

export class ApprovalQueue extends EventEmitter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this.setMaxListeners(200);
    this.timeoutMs = timeoutMs;
    this.items = new Map(); // id -> internal record
    this.resolvedOrder = [];
    this.autoDeciders = [];
  }

  // fn(approval) → decision | null. A decision settles the request immediately, before any
  // 'request' event (so no UI card / notification is shown); used for "Always allow".
  addAutoDecider(fn) {
    this.autoDeciders.push(fn);
    return () => {
      this.autoDeciders = this.autoDeciders.filter((f) => f !== fn);
    };
  }

  // → {id, promise}; promise resolves {allow, updatedInput?, message?, always?}
  request({ toolName, input = {}, conversationId = null, runId = null, timeoutMs } = {}) {
    const id = `ap-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    let resolveFn;
    const promise = new Promise((r) => (resolveFn = r));
    const rec = {
      id,
      toolName: String(toolName || 'unknown'),
      input: input && typeof input === 'object' ? input : { value: input },
      conversationId: conversationId || null,
      runId: runId || null,
      createdAt: new Date().toISOString(),
      summary: '',
      status: 'pending',
      decision: null,
      resolvedAt: null,
      promise,
      _resolve: resolveFn,
      _timer: null,
      _waiters: new Set(),
    };
    rec.summary = summarizeToolCall(rec.toolName, rec.input);
    const ms = timeoutMs ?? this.timeoutMs;
    if (ms > 0 && Number.isFinite(ms)) {
      rec._timer = setTimeout(() => this._settle(rec, { allow: false, message: TIMEOUT_MESSAGE }, 'timeout'), ms);
    }
    this.items.set(id, rec);
    for (const decide of this.autoDeciders) {
      let d = null;
      try {
        d = decide(this._public(rec));
      } catch {
        d = null;
      }
      if (d) {
        this._settle(rec, normalizeDecision(d), 'auto');
        return { id, promise };
      }
    }
    this.emit('request', this._public(rec));
    return { id, promise };
  }

  // decision: {allow, updatedInput?, message?, always?} → true if it was pending.
  resolve(id, decision) {
    const rec = this.items.get(id);
    if (!rec || rec.status !== 'pending') return false;
    this._settle(rec, normalizeDecision(decision), 'user');
    return true;
  }

  // Deny every pending approval of a run (e.g. the run was cancelled). Returns count.
  denyRun(runId, message = 'Run cancelled') {
    let n = 0;
    for (const rec of this.items.values()) {
      if (rec.status === 'pending' && rec.runId === runId) {
        this._settle(rec, { allow: false, message }, 'cancelled');
        n++;
      }
    }
    return n;
  }

  get(id) {
    const rec = this.items.get(id);
    return rec ? this._public(rec, true) : null;
  }

  pending({ runId, conversationId } = {}) {
    return [...this.items.values()]
      .filter((r) => r.status === 'pending' && (!runId || r.runId === runId) && (!conversationId || r.conversationId === conversationId))
      .map((r) => this._public(r));
  }

  // Long-poll helper for GET /api/assistant/approvals/:id/wait → {decided, decision?} | null (unknown id)
  wait(id, timeoutMs = 60_000) {
    const rec = this.items.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.status !== 'pending') return Promise.resolve({ decided: true, decision: rec.decision });
    return new Promise((resolve) => {
      const waiter = (decision) => {
        clearTimeout(t);
        resolve({ decided: true, decision });
      };
      const t = setTimeout(() => {
        rec._waiters.delete(waiter);
        resolve({ decided: false });
      }, Math.max(0, timeoutMs));
      rec._waiters.add(waiter);
    });
  }

  _settle(rec, decision, reason) {
    if (rec.status !== 'pending') return;
    clearTimeout(rec._timer);
    rec.status = reason === 'timeout' ? 'timeout' : 'resolved';
    rec.decision = decision;
    rec.resolvedAt = new Date().toISOString();
    rec._resolve(decision);
    for (const w of rec._waiters) w(decision);
    rec._waiters.clear();
    this.resolvedOrder.push(rec.id);
    while (this.resolvedOrder.length > KEEP_RESOLVED) this.items.delete(this.resolvedOrder.shift());
    this.emit('resolved', { ...this._public(rec, true), reason });
  }

  _public(rec, full = false) {
    const base = {
      id: rec.id,
      toolName: rec.toolName,
      input: rec.input,
      conversationId: rec.conversationId,
      runId: rec.runId,
      createdAt: rec.createdAt,
      summary: rec.summary,
    };
    if (!full) return base;
    return { ...base, status: rec.status, decision: rec.decision, resolvedAt: rec.resolvedAt };
  }

  close() {
    for (const rec of this.items.values()) {
      if (rec.status === 'pending') this._settle(rec, { allow: false, message: 'Cairn is shutting down' }, 'cancelled');
    }
  }
}
