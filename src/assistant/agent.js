// AssistantAgent — runs the Claude CLI as the brain of the Cairn desktop assistant.
//
// Every chat message becomes an independent *background run* (like ChatGPT Agent /
// Grok Tasks): runs keep going when no client is watching, up to
// settings.maxConcurrentRuns execute at once and the rest queue. Each run spawns
//   claude -p --output-format stream-json --verbose --model <m> [--resume <session>]
//          --strict-mcp-config --mcp-config <tmp.json>
//          --permission-prompt-tool mcp__assistant__approval_prompt
//          --allowedTools <auto-approved list> --append-system-prompt <prompt> --max-budget-usd <n>
// with the user's message on stdin. Anything not auto-approved is routed by the CLI
// to the approval_prompt MCP tool → ApprovalQueue → the bubble's Approve/Deny card.
//
// Events buffered per run and replayed to late subscribers:
//   {type:'status', message} {type:'text', text} {type:'tool', name, input, id}
//   {type:'tool_result', id, name, isError, summary} {type:'approval', approval}
//   {type:'approval_resolved', id, allow} {type:'result', text, costUsd, durationMs, sessionId}
//   {type:'error', message} {type:'done'}
// The agent itself is an EventEmitter: 'run_started', 'run_update', 'run_done' (payload =
// listRuns() row; run_done adds {text, ok, error}) and 'run_event' ({runId, conversationId, event}).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, makeTitle, writeJsonAtomic } from './conversations.js';
import { summarizeToolCall } from './approvals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_TOOLS_PATH = path.join(HERE, 'mcp-tools.js');
export const CAIRN_MCP_PATH = path.resolve(HERE, '..', 'agent', 'mcp-server.js');
export const PERMISSION_PROMPT_TOOL = 'mcp__assistant__approval_prompt';

// Every tool the assistant MCP server exposes (SPEC-ASSISTANT); all are auto-approved except clipboard_read.
export const ASSISTANT_TOOLS = [
  'schedule_task', 'list_tasks', 'cancel_task', 'notify', 'apple_reminder', 'calendar_event',
  'open_url', 'open_app', 'web_research', 'shopping_list_add', 'shopping_list', 'shopping_list_remove',
  'clipboard_read', 'clipboard_write', 'approval_prompt',
];
const ASSISTANT_NEEDS_APPROVAL = new Set(['clipboard_read']);
export const CAIRN_AUTO_TOOLS = ['search_index', 'fetch_page', 'check_robots', 'index_stats'];
export const BUILTIN_AUTO_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
export const PLAYWRIGHT_READONLY_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_tabs', 'browser_wait_for',
];

export const RUN_STATES = ['queued', 'running', 'waiting_approval', 'done', 'error', 'cancelled'];
const ACTIVE_STATES = new Set(['running', 'waiting_approval']);
const UNFINISHED_STATES = new Set(['queued', 'running', 'waiting_approval']);
const MAX_RUNS_IN_MEMORY = 50;
const MAX_EVENTS_PER_RUN = 3000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT = 3;
// Default cwd for runs: a dedicated folder (created on demand) so Claude's per-project state/auto-memory
// lives under its own slug instead of the home-level one. The home folder is still reachable via --add-dir.
export const DEFAULT_WORKDIR = path.join(os.homedir(), 'CairnWorkspace');

// Resolve (and create, for the default) the run's working directory; falls back to the home folder.
export function resolveWorkDir(dir) {
  const want = dir ? String(dir) : DEFAULT_WORKDIR;
  try {
    if (want === DEFAULT_WORKDIR && !fs.existsSync(want)) fs.mkdirSync(want, { recursive: true });
    if (fs.statSync(want).isDirectory()) return want;
  } catch {
    // fall through
  }
  return os.homedir();
}

// Env vars that tie a process to an enclosing Claude Code session; an assistant run is independent.
const SESSION_LINK_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PID', 'CLAUDE_EFFORT',
];

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SESSION_LINK_ENV) delete env[k];
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function resolveBin(bin) {
  return bin.includes('/') && !path.isAbsolute(bin) ? path.resolve(bin) : bin;
}

function oneLine(s, max = 140) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function shortToolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? `${m[1]}: ${m[2]}` : String(name || 'tool');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).filter(Boolean).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Local ISO 8601 with numeric offset, e.g. 2026-09-30T15:04:05-05:00
export function localIso(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

export function buildAllowedTools({ settings = {}, allowAlways = [] } = {}) {
  const list = [];
  for (const t of ASSISTANT_TOOLS) if (!ASSISTANT_NEEDS_APPROVAL.has(t)) list.push(`mcp__assistant__${t}`);
  for (const t of CAIRN_AUTO_TOOLS) list.push(`mcp__cairn__${t}`);
  list.push(...BUILTIN_AUTO_TOOLS);
  if (settings.allowBrowser) {
    for (const t of PLAYWRIGHT_READONLY_TOOLS) list.push(`mcp__playwright__${t}`);
    // Server-level rule: every tool of the playwright MCP server.
    if (settings.autoApproveBrowser) list.push('mcp__playwright');
  }
  for (const t of allowAlways || []) if (t) list.push(String(t));
  return [...new Set(list)];
}

export function buildSystemPrompt({ unattended = false, now = new Date(), settings = {}, workDir = DEFAULT_WORKDIR } = {}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const human = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const browser = Boolean(settings.allowBrowser);
  const lines = [
    "You are Cairn, the user's personal desktop assistant running on their Mac (similar to ChatGPT Agent / Operator / Tasks).",
    'You run in the background: the user may close the chat panel while you work and is notified when you finish, so always end with a clear, self-contained answer.',
    `Current local date/time: ${human} (${localIso(now)}), time zone ${tz}. Working directory: ${workDir} (create new files here unless the user names another location); the user's home folder ${os.homedir()} is also accessible.`,
    '',
    'Capabilities and which tool to use:',
    '- Reminders & recurring tasks: use mcp__assistant__schedule_task. Compute the exact local ISO 8601 time with offset from the current time above (e.g. "in 20 minutes", "tomorrow at 9am"). kind "reminder" notifies the user; kind "agent" with a prompt makes Cairn run that prompt at that time (e.g. a daily news summary). Use recurrence for repeating tasks; list_tasks / cancel_task to manage them. Confirm the scheduled local time in your reply.',
    '- Apple apps: only when the user explicitly asks for the Reminders or Calendar app, use apple_reminder / calendar_event (ISO times as above).',
    '- Search & research: use WebSearch / WebFetch for live results; mcp__assistant__web_research and mcp__cairn__* query and fetch through Cairn\'s robots.txt-respecting index. Cite sources with links. When the user asks you to search, look up or research something, actually run WebSearch (do not answer from memory alone) and cite at least one source link.',
    browser
      ? '- Browser (mcp__playwright__*): shopping and web tasks — navigate, read snapshots, and interact. Clicking, typing and form filling require the user\'s approval unless auto-approved.'
      : '- Browser automation is disabled; use web search/fetch and give the user links instead.',
    '- Shopping: research, then compare options in a markdown table (Product | Store | Price | Rating | Link). You may add items to a store cart or to the shopping list (shopping_list_add). NEVER enter payment details, passwords or card numbers and NEVER place an order — hand checkout to the user with the link.',
    '- Computer tasks: files (Read/Glob/Grep, Write/Edit), terminal (Bash), open_app / open_url, clipboard_write, notify. Risky actions are automatically sent to the user for approval; if an action is denied, do not retry it — explain and suggest an alternative.',
    '',
    'Rules: ask before sending any message, email or post on the user\'s behalf; never delete files unless explicitly asked (prefer moving to Trash); never reveal secrets; be concise and use short markdown.',
  ];
  if (unattended) {
    lines.push('', 'This is an UNATTENDED scheduled run — the user is not watching. Do not ask questions; make reasonable assumptions, skip any action that is not approved, and finish with a short summary of what you did or found.');
  }
  return lines.join('\n');
}

// isolateSettings: `--setting-sources ""` — ignore ~/.claude/settings.json (its permissions.allow rules such as
// Bash(git push *), plugins, hooks) so Cairn's approval queue is the only thing that can allow risky tools.
// Managed (policy) settings and the Enterprise login still apply. Default ON (settings.isolateClaudeSettings
// !== false): verified live on CLI 2.1.286 that auth works and a user-allowed `git push` is no longer auto-run.
// addDirs: extra `--add-dir` directories (the home folder when the cwd is ~/CairnWorkspace).
export function buildArgs({ model, resumeSessionId, mcpConfigFile, permissionPromptTool = PERMISSION_PROMPT_TOOL, allowedTools = [], systemPrompt, maxBudgetUsd, isolateSettings = false, addDirs = [] }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (isolateSettings) args.push('--setting-sources', '');
  if (model) args.push('--model', String(model));
  if (resumeSessionId) args.push('--resume', String(resumeSessionId));
  for (const d of addDirs || []) if (d) args.push('--add-dir', String(d));
  args.push('--strict-mcp-config');
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
  if (permissionPromptTool) args.push('--permission-prompt-tool', permissionPromptTool);
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null && Number(maxBudgetUsd) > 0) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  return args;
}

// ---------------------------------------------------------------------------

export class AssistantAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {{config, audit}} o.runtime
   * @param {import('./conversations.js').ConversationStore} o.conversations
   * @param {import('./approvals.js').ApprovalQueue} o.approvals
   * @param {() => string} o.getApiUrl
   * @param {object|(() => object)} o.settings  read at use time
   * @param {string} [o.runsFile]  default <dataDir>/runs.json
   * @param {object} [o.env]  extra env for the claude child (tests)
   * @param {{mcpTools?: string, cairnMcp?: string}} [o.paths]
   */
  constructor({ runtime, conversations, approvals, getApiUrl, settings = {}, runsFile, env, paths = {} } = {}) {
    super();
    this.setMaxListeners(100);
    if (!conversations) throw new Error('AssistantAgent requires conversations');
    this.runtime = runtime || {};
    this.conversations = conversations;
    this.approvals = approvals || null;
    this.getApiUrl = getApiUrl || (() => this.runtime.config?.publicBaseUrl || 'http://127.0.0.1:8787');
    this._settings = settings;
    this.extraEnv = env || {};
    this.paths = { mcpTools: paths.mcpTools || MCP_TOOLS_PATH, cairnMcp: paths.cairnMcp || CAIRN_MCP_PATH };
    const dataDir = this.runtime.config?.dataDir;
    this.runsFile = runsFile !== undefined ? runsFile : dataDir ? path.join(dataDir, 'runs.json') : null;
    this.runs = new Map(); // runId -> run (insertion order = creation order)
    this.queue = []; // runIds waiting to start
    this.stopped = false;
    this._loadRuns();

    if (this.approvals) {
      this._onApprovalRequest = (a) => this._handleApprovalRequest(a);
      this._onApprovalResolved = (a) => this._handleApprovalResolved(a);
      this.approvals.on('request', this._onApprovalRequest);
      this.approvals.on('resolved', this._onApprovalResolved);
      this._removeDecider = this.approvals.addAutoDecider?.((a) => this._autoDecide(a)) || null;
    }
  }

  get settings() {
    const s = typeof this._settings === 'function' ? this._settings() : this._settings;
    return s || {};
  }

  // ---- public API ---------------------------------------------------------

  startRun({ conversationId, message, unattended = false, title } = {}) {
    const text = String(message ?? '').trim();
    if (!text) throw new Error('message is required');
    let conv = conversationId ? this.conversations.get(conversationId) : null;
    if (!conv) conv = this.conversations.create({ title: title || text });
    const userMsg = this.conversations.append(conv.id, { role: 'user', text });
    const now = new Date().toISOString();
    const run = {
      runId: newId('run'),
      conversationId: conv.id,
      title: makeTitle(title || text),
      message: text,
      unattended: Boolean(unattended),
      state: 'queued',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      lastEvent: 'Queued',
      costUsd: null,
      error: null,
      text: '',
      sessionId: null,
      userMessageId: userMsg?.id || null,
      events: [],
      subscribers: new Set(),
      pendingApprovals: new Set(),
      child: null,
      cancelRequested: false,
      _done: null,
    };
    run.donePromise = new Promise((r) => (run._done = r));
    this.runs.set(run.runId, run);
    this.queue.push(run.runId);
    this._pruneRuns();
    this.emit('run_started', this._row(run));
    this._persistRuns();
    this._pump();
    if (run.state === 'queued') {
      const ahead = this.queue.indexOf(run.runId);
      this._emit(run, { type: 'status', message: ahead > 0 ? `Queued — ${ahead} task${ahead === 1 ? '' : 's'} ahead` : 'Queued — waiting for a free slot' });
    }
    return { runId: run.runId, conversationId: run.conversationId };
  }

  // Replays buffered events, then streams live ones. Returns an unsubscribe function.
  subscribe(runId, fn) {
    const run = this.runs.get(runId);
    if (!run || typeof fn !== 'function') return () => {};
    for (const ev of run.events.slice()) safeCall(fn, ev);
    if (!UNFINISHED_STATES.has(run.state) && run.events.some((e) => e.type === 'done')) return () => {};
    run.subscribers.add(fn);
    return () => run.subscribers.delete(fn);
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { ...this._row(run), text: run.text, error: run.error, events: run.events.slice() };
  }

  listRuns({ limit = 30, conversationId, state } = {}) {
    const rows = [];
    const all = [...this.runs.values()].reverse();
    for (const run of all) {
      if (conversationId && run.conversationId !== conversationId) continue;
      if (state && run.state !== state) continue;
      rows.push(this._row(run));
      if (rows.length >= limit) break;
    }
    return rows;
  }

  counts() {
    const c = { queued: 0, running: 0, waiting_approval: 0 };
    for (const r of this.runs.values()) if (c[r.state] !== undefined) c[r.state]++;
    return { runningRuns: c.running + c.waiting_approval, queuedRuns: c.queued, waitingApproval: c.waiting_approval };
  }

  // Resolves with the run row (+ text, ok, error) once the run has finished.
  waitForRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve(null);
    return run.donePromise;
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || !UNFINISHED_STATES.has(run.state)) return false;
    run.cancelRequested = true;
    this.approvals?.denyRun?.(runId, 'Run cancelled by the user');
    if (run.state === 'queued') {
      this.queue = this.queue.filter((id) => id !== runId);
      this._finish(run, { state: 'cancelled', error: 'Cancelled', text: '' });
      return true;
    }
    this._emit(run, { type: 'status', message: 'Cancelling…' });
    killChild(run.child);
    return true;
  }

  // For scheduled agent tasks: new conversation "Scheduled: …", unattended, waits for completion.
  async runOnce(prompt, { unattended = true, title } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) return { ok: false, text: '', costUsd: null, error: 'empty prompt' };
    const convTitle = `Scheduled: ${title || text}`;
    const conv = this.conversations.create({ title: convTitle });
    const { runId, conversationId } = this.startRun({ conversationId: conv.id, message: text, unattended, title: convTitle });
    const res = await this.waitForRun(runId);
    return { ok: Boolean(res?.ok), text: res?.text || '', costUsd: res?.costUsd ?? null, error: res?.error || null, runId, conversationId };
  }

  stop() {
    this.stopped = true;
    for (const run of this.runs.values()) if (UNFINISHED_STATES.has(run.state)) this.cancel(run.runId);
    if (this.approvals) {
      this.approvals.off('request', this._onApprovalRequest);
      this.approvals.off('resolved', this._onApprovalResolved);
      this._removeDecider?.();
    }
    this._persistRuns();
  }

  close() {
    this.stop();
  }

  // ---- scheduling ----------------------------------------------------------

  _maxConcurrent() {
    const n = Number(this.settings.maxConcurrentRuns);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
  }

  _activeCount() {
    let n = 0;
    for (const r of this.runs.values()) if (ACTIVE_STATES.has(r.state) || r._starting) n++;
    return n;
  }

  _pump() {
    if (this.stopped) return;
    let free = this._maxConcurrent() - this._activeCount();
    if (free <= 0) return;
    // Runs of the same conversation are serialized so they share one Claude session in order.
    const busyConvs = new Set([...this.runs.values()].filter((r) => ACTIVE_STATES.has(r.state) || r._starting).map((r) => r.conversationId));
    for (const runId of this.queue.slice()) {
      if (free <= 0) break;
      const run = this.runs.get(runId);
      if (!run || run.state !== 'queued') {
        this.queue = this.queue.filter((id) => id !== runId);
        continue;
      }
      if (busyConvs.has(run.conversationId)) continue;
      this.queue = this.queue.filter((id) => id !== runId);
      busyConvs.add(run.conversationId);
      free--;
      this._execute(run);
    }
  }

  async _execute(run) {
    run._starting = true;
    run.startedAt = new Date().toISOString();
    this._setState(run, 'running');
    run._starting = false;
    const started = Date.now();
    const settings = this.settings;
    const config = this.runtime.config || {};
    const model = settings.model || config.agent?.model || undefined;
    let outcome;
    let resumedFailed = false;
    let workTmp = null;
    try {
      workTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-assistant-'));
      const conv = this.conversations.get(run.conversationId);
      const resumeId = conv?.sessionId || null;
      outcome = await this._attempt(run, { conv, resumeId, model, workTmp, prompt: run.message });
      if (resumeId && outcome.resumeFailed && !run.cancelRequested) {
        resumedFailed = true;
        this._emit(run, { type: 'status', message: 'Previous Claude session could not be resumed — continuing in a fresh session' });
        const fresh = this.conversations.get(run.conversationId);
        outcome = await this._attempt(run, { conv: fresh, resumeId: null, model, workTmp, prompt: withHistory(fresh, run) });
      }
    } catch (e) {
      outcome = { ok: false, error: e.message || String(e), text: '', costUsd: null, sessionId: null };
    } finally {
      if (workTmp) fs.rmSync(workTmp, { recursive: true, force: true });
    }

    const durationMs = outcome.durationMs ?? Date.now() - started;
    const cancelled = run.cancelRequested;
    const ok = !cancelled && Boolean(outcome.ok);
    const state = cancelled ? 'cancelled' : ok ? 'done' : 'error';
    const error = cancelled ? 'Cancelled' : ok ? null : outcome.error || 'Claude run failed';

    // Persist results to the conversation.
    try {
      if (outcome.sessionId && (ok || outcome.sessionUsable)) this.conversations.setSession(run.conversationId, outcome.sessionId);
      if (ok) {
        this.conversations.append(run.conversationId, {
          role: 'assistant', text: outcome.text, costUsd: outcome.costUsd, durationMs, runId: run.runId, events: compactSteps(run.events),
        });
      } else if (outcome.text) {
        this.conversations.append(run.conversationId, {
          role: 'assistant', text: outcome.text, costUsd: outcome.costUsd, durationMs, runId: run.runId, partial: true, error, events: compactSteps(run.events),
        });
      } else {
        this.conversations.append(run.conversationId, { role: 'system', text: cancelled ? 'Run cancelled.' : `Run failed: ${error}`, runId: run.runId, error });
      }
    } catch {
      // Conversation deleted mid-run — nothing to save.
    }

    try {
      this.runtime.audit?.record?.({
        kind: 'agent', mode: 'assistant', runId: run.runId, conversationId: run.conversationId, model: model || null,
        unattended: run.unattended, ok, state, costUsd: outcome.costUsd ?? null, durationMs,
        tools: run.events.filter((e) => e.type === 'tool').length, resumed: Boolean(outcome.resumed), resumeRetried: resumedFailed,
        question: oneLine(run.message, 200), ...(error && !cancelled ? { error } : {}),
      });
    } catch {
      // Audit problems must never break a run.
    }

    if (ok) this._emit(run, { type: 'result', text: outcome.text, costUsd: outcome.costUsd, durationMs, sessionId: outcome.sessionId });
    else if (!cancelled) this._emit(run, { type: 'error', message: error });
    this._finish(run, { state, error, text: outcome.text || '', costUsd: outcome.costUsd ?? null });
  }

  // One CLI invocation. Resolves {ok, text, costUsd, durationMs, sessionId, error, resumeFailed, resumed, sessionUsable}.
  _attempt(run, { conv, resumeId, model, workTmp, prompt }) {
    const settings = this.settings;
    const config = this.runtime.config || {};
    const bin = resolveBin(config.agent?.claudeBin || 'claude');
    const apiUrl = String(this.getApiUrl() || '').replace(/\/+$/, '');
    const hasAssistantMcp = fs.existsSync(this.paths.mcpTools);
    const sourcesFile = path.join(workTmp, 'sources.json');
    if (!fs.existsSync(sourcesFile)) fs.writeFileSync(sourcesFile, '[]');

    const mcpServers = {};
    if (hasAssistantMcp) {
      mcpServers.assistant = {
        command: process.execPath,
        args: [this.paths.mcpTools],
        env: {
          CAIRN_API: apiUrl,
          CAIRN_CONVERSATION_ID: run.conversationId,
          CAIRN_RUN_ID: run.runId,
          CAIRN_UNATTENDED: run.unattended ? '1' : '0',
        },
      };
    }
    if (fs.existsSync(this.paths.cairnMcp)) {
      mcpServers.cairn = { command: process.execPath, args: [this.paths.cairnMcp], env: { CAIRN_API: apiUrl, CAIRN_SOURCES_FILE: sourcesFile } };
    }
    if (settings.allowBrowser) {
      mcpServers.playwright = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
    }
    const mcpConfigFile = path.join(workTmp, 'mcp-config.json');
    fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });

    const workDir = resolveWorkDir(settings.workDir);
    const home = os.homedir();
    const args = buildArgs({
      model,
      resumeSessionId: resumeId,
      mcpConfigFile,
      permissionPromptTool: hasAssistantMcp ? PERMISSION_PROMPT_TOOL : null,
      allowedTools: buildAllowedTools({ settings, allowAlways: conv?.allowAlways || [] }),
      systemPrompt: buildSystemPrompt({ unattended: run.unattended, settings, workDir }),
      maxBudgetUsd: settings.maxBudgetUsd ?? config.agent?.maxBudgetUsd,
      isolateSettings: settings.isolateClaudeSettings !== false,
      addDirs: path.resolve(workDir) !== home ? [home] : [],
    });
    run.lastArgs = args;
    if (!hasAssistantMcp) this._emit(run, { type: 'status', message: 'Assistant tools (mcp-tools.js) not installed — running without them' });
    const timeoutMs = Number(settings.runTimeoutMs) > 0 ? Number(settings.runTimeoutMs) : DEFAULT_RUN_TIMEOUT_MS;

    return new Promise((resolve) => {
      const started = Date.now();
      const texts = [];
      const toolNames = new Map();
      let contentEvents = 0;
      let resultMsg = null;
      let initSession = null;
      let initSeen = false;
      let stderr = '';
      let buffer = '';
      let settled = false;
      let timedOut = false;
      let child;

      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.child = null;
        const ok = !extra.error && Boolean(resultMsg) && !resultMsg.is_error && (!resultMsg.subtype || resultMsg.subtype === 'success');
        // On error results `result` holds the error message, not assistant text.
        const resultText = ok && typeof resultMsg?.result === 'string' ? resultMsg.result.trim() : '';
        // The CLI's `result` is only the LAST assistant text block. When a turn has several blocks (e.g. a
        // comparison table, then a tool call, then "Added to your list"), keep everything the user saw.
        const joined = texts.map((t) => String(t).trim()).filter(Boolean).join('\n\n');
        let text;
        if (!resultText) text = joined;
        else if (texts.length > 1) text = joined.includes(resultText) ? joined : `${joined}\n\n${resultText}`;
        else text = resultText;
        text = text.trim();
        let error = extra.error || null;
        if (!ok && !error) {
          const errs = Array.isArray(resultMsg?.errors) ? resultMsg.errors.filter(Boolean).join('; ') : '';
          if (resultMsg) error = errs || (typeof resultMsg.result === 'string' && resultMsg.result) || `Claude reported an error (${resultMsg.subtype || 'is_error'})`;
          else error = `Claude CLI exited${extra.code != null ? ` with code ${extra.code}` : ''} without a result${stderr.trim() ? `: ${oneLine(stderr.trim().slice(-400), 400)}` : ''}`;
        }
        // A missing/expired session fails before any init line ("No conversation found with session ID").
        const resumeFailed = Boolean(resumeId) && !ok && !run.cancelRequested && !timedOut && contentEvents === 0 &&
          (!initSeen || /conversation|session/i.test(error || ''));
        const sessionId = resultMsg?.session_id || initSession || null;
        resolve({
          ok,
          text,
          costUsd: typeof resultMsg?.total_cost_usd === 'number' ? resultMsg.total_cost_usd : null,
          durationMs: typeof resultMsg?.duration_ms === 'number' ? resultMsg.duration_ms : Date.now() - started,
          sessionId: resumeFailed ? null : sessionId,
          sessionUsable: !resumeFailed && contentEvents > 0,
          error: ok ? null : error,
          resumeFailed,
          resumed: Boolean(resumeId),
          stderr: stderr.slice(-2000),
        });
      };

      const handleMessage = (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'system' && msg.subtype === 'init') {
          initSeen = true;
          initSession = msg.session_id || initSession;
          const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
          const failed = servers.filter((s) => s && s.status && s.status !== 'connected').map((s) => `${s.name} (${s.status})`);
          this._emit(run, {
            type: 'status',
            message: `Claude session ${resumeId ? 'resumed' : 'started'} (${msg.model || model || 'default model'})${failed.length ? ` — MCP not connected: ${failed.join(', ')}` : ''}`,
            sessionId: initSession,
          });
          return;
        }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const c of msg.message.content) {
            if (c?.type === 'text' && c.text) {
              contentEvents++;
              texts.push(c.text);
              this._emit(run, { type: 'text', text: c.text });
            } else if (c?.type === 'tool_use') {
              contentEvents++;
              toolNames.set(c.id, c.name);
              this._emit(run, { type: 'tool', name: c.name, input: c.input ?? {}, id: c.id || null, summary: summarizeToolCall(c.name, c.input ?? {}) });
            }
          }
          return;
        }
        if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          for (const c of msg.message.content) {
            if (c?.type !== 'tool_result') continue;
            contentEvents++;
            const id = c.tool_use_id || null;
            this._emit(run, { type: 'tool_result', id, name: toolNames.get(id) || 'tool', isError: Boolean(c.is_error), summary: oneLine(toolResultText(c.content), 300) });
          }
          return;
        }
        if (msg.type === 'result') resultMsg = msg;
      };

      const handleLine = (line) => {
        const t = line.trim();
        if (!t) return;
        let msg;
        try {
          msg = JSON.parse(t);
        } catch {
          return;
        }
        try {
          handleMessage(msg);
        } catch {
          // ignore malformed message shapes
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, timeoutMs);
      timer.unref?.();

      try {
        child = spawn(bin, args, {
          cwd: workDir,
          env: childEnv({ ...this.extraEnv, CAIRN_API: apiUrl }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        return finish({ error: spawnErrorMessage(e, bin) });
      }
      run.child = child;
      if (run.cancelRequested) killChild(child);
      this._emit(run, { type: 'status', message: resumeId ? 'Continuing conversation with Claude…' : `Starting Claude (${model || 'default model'})…` });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
      });
      child.stdin.on('error', () => {});
      child.on('error', (e) => finish({ error: spawnErrorMessage(e, bin) }));
      child.on('close', (code) => {
        if (buffer) handleLine(buffer);
        buffer = '';
        if (run.cancelRequested) return finish({ error: 'Cancelled' });
        if (timedOut) return finish({ error: `Claude run timed out after ${Math.round(timeoutMs / 1000)} s` });
        finish({ code });
      });
      child.stdin.end(String(prompt ?? ''));
    });
  }

  // ---- events & state -------------------------------------------------------

  _emit(run, event) {
    const ev = { ...event, ts: new Date().toISOString() };
    run.events.push(ev);
    if (run.events.length > MAX_EVENTS_PER_RUN) run.events.splice(1, run.events.length - MAX_EVENTS_PER_RUN);
    const line = describeEvent(ev);
    if (line) run.lastEvent = line;
    for (const fn of [...run.subscribers]) safeCall(fn, ev);
    if (this.listenerCount('run_event')) this.emit('run_event', { runId: run.runId, conversationId: run.conversationId, event: ev });
  }

  _setState(run, state) {
    if (run.state === state) return;
    run.state = state;
    this._persistRuns();
    this.emit('run_update', this._row(run));
  }

  _finish(run, { state, error = null, text = '', costUsd = null }) {
    if (!UNFINISHED_STATES.has(run.state) && run.finishedAt) return;
    run.error = error;
    run.text = text;
    if (costUsd !== null && costUsd !== undefined) run.costUsd = costUsd;
    run.finishedAt = new Date().toISOString();
    run.pendingApprovals.clear();
    if (state === 'cancelled') run.lastEvent = 'Cancelled';
    this._emit(run, { type: 'done', state });
    run.subscribers.clear();
    run.child = null;
    this._setState(run, state);
    const row = { ...this._row(run), text: run.text, ok: state === 'done', error: run.error };
    this.emit('run_done', row);
    run._done(row);
    this._pruneRuns();
    this._persistRuns();
    setImmediate(() => this._pump());
  }

  _handleApprovalRequest(approval) {
    const run = approval?.runId ? this.runs.get(approval.runId) : null;
    if (!run || !UNFINISHED_STATES.has(run.state)) return;
    run.pendingApprovals.add(approval.id);
    this._emit(run, { type: 'approval', approval });
    if (run.state === 'running') this._setState(run, 'waiting_approval');
  }

  // "Always allow" granted earlier in a running run (its --allowedTools was fixed at spawn): approve silently.
  _autoDecide(approval) {
    const run = approval?.runId ? this.runs.get(approval.runId) : null;
    const convId = run?.conversationId || approval?.conversationId;
    if (!convId || !approval.toolName) return null;
    const conv = this.conversations.get(convId);
    if (!conv?.allowAlways?.includes(approval.toolName)) return null;
    if (run && UNFINISHED_STATES.has(run.state)) this._emit(run, { type: 'status', message: `Auto-approved (always allowed): ${approval.summary}` });
    return { allow: true, updatedInput: approval.input };
  }

  _handleApprovalResolved(approval) {
    if (!approval) return;
    const allow = Boolean(approval.decision?.allow);
    if (allow && approval.decision?.always && approval.conversationId && approval.toolName) {
      try {
        this.conversations.addAllowAlways?.(approval.conversationId, approval.toolName);
      } catch {
        // ignore
      }
    }
    const run = approval.runId ? this.runs.get(approval.runId) : null;
    if (!run || !run.pendingApprovals.has(approval.id)) return;
    run.pendingApprovals.delete(approval.id);
    this._emit(run, { type: 'approval_resolved', id: approval.id, allow, message: approval.decision?.message || null });
    if (run.state === 'waiting_approval' && run.pendingApprovals.size === 0) this._setState(run, 'running');
  }

  _row(run) {
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      title: run.title,
      state: run.state,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      lastEvent: run.lastEvent,
      costUsd: run.costUsd,
      createdAt: run.createdAt,
      unattended: run.unattended,
      error: run.error,
      pendingApprovals: run.pendingApprovals ? run.pendingApprovals.size : 0,
    };
  }

  _pruneRuns() {
    if (this.runs.size <= MAX_RUNS_IN_MEMORY) return;
    for (const [id, r] of this.runs) {
      if (this.runs.size <= MAX_RUNS_IN_MEMORY) break;
      if (!UNFINISHED_STATES.has(r.state)) this.runs.delete(id);
    }
  }

  // ---- runs.json -------------------------------------------------------------

  _loadRuns() {
    if (!this.runsFile || !fs.existsSync(this.runsFile)) return;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(this.runsFile, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(list)) list = Array.isArray(list?.runs) ? list.runs : [];
    let changed = false;
    for (const r of list.slice(-MAX_RUNS_IN_MEMORY)) {
      if (!r?.runId) continue;
      const interrupted = UNFINISHED_STATES.has(r.state);
      if (interrupted) changed = true;
      const run = {
        runId: r.runId,
        conversationId: r.conversationId || null,
        title: r.title || '',
        message: '',
        unattended: Boolean(r.unattended),
        state: interrupted ? 'error' : RUN_STATES.includes(r.state) ? r.state : 'error',
        createdAt: r.createdAt || r.startedAt || null,
        startedAt: r.startedAt || null,
        finishedAt: interrupted ? new Date().toISOString() : r.finishedAt || null,
        lastEvent: interrupted ? 'Interrupted (Cairn restarted)' : r.lastEvent || '',
        costUsd: r.costUsd ?? null,
        error: interrupted ? 'interrupted' : r.error || null,
        text: r.summary || '',
        events: [],
        subscribers: new Set(),
        pendingApprovals: new Set(),
        child: null,
        cancelRequested: false,
      };
      const ts = run.finishedAt || new Date().toISOString();
      if (run.state === 'done') run.events.push({ type: 'result', text: run.text, costUsd: run.costUsd, durationMs: null, sessionId: null, ts });
      else if (run.state === 'error') run.events.push({ type: 'error', message: run.error || 'error', ts });
      run.events.push({ type: 'done', state: run.state, ts });
      const row = { ...this._row(run), text: run.text, ok: run.state === 'done', error: run.error };
      run.donePromise = Promise.resolve(row);
      this.runs.set(run.runId, run);
    }
    if (changed) this._persistRuns();
  }

  _persistRuns() {
    if (!this.runsFile) return;
    try {
      const list = [...this.runs.values()].map((r) => ({
        ...this._row(r),
        pendingApprovals: undefined,
        summary: oneLine(r.text, 500),
      }));
      writeJsonAtomic(this.runsFile, list);
    } catch {
      // Persistence is best effort; the in-memory state stays authoritative.
    }
  }
}

// ---------------------------------------------------------------------------

function safeCall(fn, ev) {
  try {
    fn(ev);
  } catch {
    // A misbehaving subscriber must not break the run.
  }
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }, 2000);
  t.unref?.();
}

function spawnErrorMessage(e, bin) {
  if (e.code === 'ENOENT') return `Claude CLI not found ("${bin}"). Install Claude Code or set agent.claudeBin / CAIRN_CLAUDE_BIN.`;
  if (e.code === 'EACCES') return `Claude CLI "${bin}" is not executable.`;
  return e.message;
}

// One-line description of an event for listRuns().lastEvent.
export function describeEvent(ev) {
  switch (ev?.type) {
    case 'status':
      return oneLine(ev.message);
    case 'text':
      return oneLine(ev.text, 120);
    case 'tool':
      return oneLine(ev.summary || `Using ${shortToolName(ev.name)}`);
    case 'tool_result':
      return `${shortToolName(ev.name)} ${ev.isError ? 'failed' : 'finished'}`;
    case 'approval':
      return oneLine(`Waiting for approval: ${ev.approval?.summary || ev.approval?.toolName || ''}`);
    case 'approval_resolved':
      return ev.allow ? 'Approved — continuing' : 'Denied by user';
    case 'result':
      return oneLine(ev.text, 120) || 'Finished';
    case 'error':
      return oneLine(`Error: ${ev.message}`);
    default:
      return null;
  }
}

// Small, display-only copy of a tool input (for step chips in history): scalar fields only, file bodies dropped.
const BULKY_INPUT_KEYS = new Set(['content', 'new_string', 'old_string', 'edits', 'code', 'function']);
export function compactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (BULKY_INPUT_KEYS.has(k) || n >= 8) continue;
    if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 199) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

// Compact tool-step list stored with the assistant message.
function compactSteps(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'tool') out.push({ type: 'tool', id: e.id, name: e.name, input: compactInput(e.input), summary: e.summary || summarizeToolCall(e.name, e.input) });
    else if (e.type === 'tool_result') out.push({ type: 'tool_result', id: e.id, name: e.name, isError: e.isError, summary: oneLine(e.summary, 160) });
    else if (e.type === 'approval') out.push({ type: 'approval', id: e.approval?.id, name: e.approval?.toolName, summary: e.approval?.summary });
    else if (e.type === 'approval_resolved') out.push({ type: 'approval_resolved', id: e.id, allow: e.allow });
    if (out.length >= 100) break;
  }
  return out;
}

// When --resume fails we start a fresh session; give Claude the recent transcript for context.
function withHistory(conv, run) {
  const msgs = (conv?.messages || []).filter((m) => m.id !== run.userMessageId && (m.role === 'user' || m.role === 'assistant'));
  if (!msgs.length) return run.message;
  let transcript = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const line = `${msgs[i].role === 'user' ? 'User' : 'Assistant'}: ${String(msgs[i].text || '').slice(0, 1500)}\n`;
    if (transcript.length + line.length > 6000) break;
    transcript = line + transcript;
  }
  return `(Earlier conversation with the user, for context — the previous session could not be resumed:)\n${transcript}\n---\n${run.message}`;
}
