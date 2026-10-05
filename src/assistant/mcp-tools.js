#!/usr/bin/env node
// Cairn "assistant" MCP server (stdio, JSON-RPC 2.0, newline-delimited JSON).
// Gives the Claude CLI personal-assistant tools (tasks & reminders, notifications,
// Reminders/Calendar, open URL/app, shopping list, clipboard, index search) and the
// permission prompt tool `approval_prompt` used with
//   claude -p --permission-prompt-tool mcp__assistant__approval_prompt
// Every tool proxies to the running Cairn HTTP API (CAIRN_API); nothing here touches
// the Mac directly. stdout carries protocol only; logs go to stderr.
//
// Env:
//   CAIRN_API                  base URL of the Cairn server (default http://127.0.0.1:8787)
//   CAIRN_CONVERSATION_ID      conversation this Claude run belongs to (sent with approvals)
//   CAIRN_RUN_ID               run id (sent with approvals)
//   CAIRN_UNATTENDED           '1' for scheduled/background runs nobody is watching:
//                              approvals not decided within CAIRN_APPROVAL_UNATTENDED_MS → deny
//   CAIRN_APPROVAL_POLL_MS     long-poll window per /wait request (default 60000)
//   CAIRN_APPROVAL_MAX_MS      overall approval wait (default 300000 = 5 min)
//   CAIRN_APPROVAL_UNATTENDED_MS  unattended approval wait (default 60000)
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseIsoLocal, localIso, safeHttpUrl } from './macos.js';

const PROTOCOL_VERSION = '2025-06-18';
const API = (process.env.CAIRN_API || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CONVERSATION_ID = process.env.CAIRN_CONVERSATION_ID || null;
const RUN_ID = process.env.CAIRN_RUN_ID || null;
const UNATTENDED = process.env.CAIRN_UNATTENDED === '1';
const envMs = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const POLL_MS = envMs('CAIRN_APPROVAL_POLL_MS', 60_000);
const MAX_MS = envMs('CAIRN_APPROVAL_MAX_MS', 300_000);
const UNATTENDED_MS = envMs('CAIRN_APPROVAL_UNATTENDED_MS', 60_000);

const log = (...args) => process.stderr.write(`[cairn-assistant-mcp] ${args.join(' ')}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// ---------- Cairn HTTP API client ----------
class ToolError extends Error {}

async function api(method, route, body, { timeoutMs = 30_000, signal } = {}) {
  const hasBody = method === 'POST' || method === 'DELETE';
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(API + route, {
      method,
      // POST/DELETE must carry application/json (Cairn's CSRF guard).
      headers: hasBody ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ToolError(`Cairn API unreachable at ${API} (${e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ToolError(`Cairn API ${method} ${route} failed: HTTP ${res.status}${data?.error ? ` — ${data.error}` : ''}`);
  return data ?? {};
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const optStr = (v) => (str(v) ? str(v) : undefined);
const requireStr = (args, key, hint = '') => {
  const v = str(args?.[key]);
  if (!v) throw new ToolError(`"${key}" is required.${hint ? ' ' + hint : ''}`);
  return v;
};
const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const nowHint = () => `Current local time is ${localIso(new Date())} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;

function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return String(iso ?? 'unscheduled');
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Parse an ISO time argument into a local ISO string with offset, or throw a helpful error. */
function requireIso(args, key, { allowPast = true } = {}) {
  const raw = requireStr(args, key, 'Use ISO 8601, e.g. 2026-10-01T09:00:00.');
  const d = parseIsoLocal(raw);
  if (!d) throw new ToolError(`"${key}" must be an ISO 8601 date-time such as 2026-10-01T09:00:00 (local) or 2026-10-01T09:00:00-07:00; got "${raw}". Convert relative phrases ("tomorrow at 9") to an exact time yourself. ${nowHint()}`);
  if (!allowPast && d.getTime() < Date.now() - 60_000) throw new ToolError(`"${key}" (${localIso(d)}) is in the past. ${nowHint()}`);
  return localIso(d);
}

function describeRecurrence(r) {
  if (!r || typeof r !== 'object' || !r.every) return '';
  const n = Number(r.interval) > 1 ? `${r.interval} ${r.every}s` : r.every;
  let s = `repeats every ${n}`;
  if (r.days?.length) s += ` on ${r.days.join(', ')}`;
  if (r.at) s += ` at ${r.at}`;
  return s;
}

function describeTask(t) {
  const parts = [`[${t.id}] ${t.kind === 'agent' ? 'Agent task' : 'Reminder'}: "${t.title}"`, `next ${fmtDate(t.nextRunAt)}`];
  const rec = describeRecurrence(t.recurrence);
  if (rec) parts.push(rec);
  if (t.status && t.status !== 'active') parts.push(`status ${t.status}`);
  if (t.kind === 'agent' && t.prompt) parts.push(`prompt: ${String(t.prompt).slice(0, 120)}`);
  return parts.join(' — ');
}

function macOutcome(data, doneText) {
  const r = data?.result && typeof data.result === 'object' ? data.result : data;
  if (r?.ok === false) throw new ToolError(r.error || 'The macOS action failed.');
  return textResult(`${doneText}${r?.dryRun ? ' (dry run — nothing was actually changed on this Mac)' : ''}`);
}

// ---------- recurrence validation ----------
const EVERY = ['minute', 'hour', 'day', 'week', 'weekday'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function normalizeRecurrence(r) {
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'object' || Array.isArray(r)) throw new ToolError('"recurrence" must be an object like {"every":"day","at":"08:00"}.');
  const every = str(r.every).toLowerCase();
  if (!EVERY.includes(every)) throw new ToolError(`recurrence.every must be one of ${EVERY.join(', ')}.`);
  const out = { every };
  if (r.interval !== undefined && r.interval !== null) {
    const n = Number(r.interval);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ToolError('recurrence.interval must be a whole number ≥ 1.');
    out.interval = n;
  }
  if (r.at !== undefined && r.at !== null && r.at !== '') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str(r.at));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ToolError('recurrence.at must be 24-hour "HH:MM" local time, e.g. "08:30".');
    out.at = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  if (r.days !== undefined && r.days !== null) {
    if (!Array.isArray(r.days)) throw new ToolError('recurrence.days must be an array such as ["mon","wed"].');
    const days = r.days.map((d) => str(d).toLowerCase().slice(0, 3));
    const bad = days.filter((d) => !DAYS.includes(d));
    if (bad.length) throw new ToolError(`recurrence.days contains invalid day(s): ${bad.join(', ')}. Use ${DAYS.join(', ')}.`);
    if (days.length) out.days = [...new Set(days)];
  }
  return out;
}

// ---------- tool handlers ----------
async function scheduleTask(args) {
  const title = requireStr(args, 'title');
  const kind = str(args.kind || 'reminder').toLowerCase();
  if (kind !== 'reminder' && kind !== 'agent') throw new ToolError('"kind" must be "reminder" or "agent".');
  const recurrence = normalizeRecurrence(args.recurrence);
  const when = requireIso(args, 'when', { allowPast: Boolean(recurrence) });
  const prompt = optStr(args.prompt);
  if (kind === 'agent' && !prompt) throw new ToolError('"prompt" is required for kind "agent": write the full, self-contained instruction the assistant should carry out at that time.');
  const body = compact({ title, when, kind, prompt, notes: optStr(args.notes), recurrence });
  const data = await api('POST', '/api/assistant/tasks', body);
  const task = data.task || data;
  if (!task?.id) throw new ToolError('Cairn did not return the scheduled task.');
  const what = kind === 'agent' ? 'agent task' : 'reminder';
  return textResult(
    `Scheduled ${what} "${task.title || title}" (id ${task.id}) for ${fmtDate(task.nextRunAt || when)}` +
      `${describeRecurrence(task.recurrence || recurrence) ? ` — ${describeRecurrence(task.recurrence || recurrence)}` : ''}. ` +
      `Cairn will ${kind === 'agent' ? 'run it in the background and notify the user with the result' : 'show a macOS notification and a bubble alert'} at that time.`,
  );
}

async function listTasks() {
  const data = await api('GET', '/api/assistant/tasks');
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!tasks.length) return textResult('No upcoming reminders or scheduled tasks.');
  return textResult([`${tasks.length} scheduled item(s):`, ...tasks.map(describeTask)].join('\n'));
}

async function cancelTask(args) {
  const id = requireStr(args, 'id', 'Call list_tasks to find the id.');
  await api('DELETE', `/api/assistant/tasks/${encodeURIComponent(id)}`, {});
  return textResult(`Cancelled scheduled task ${id}.`);
}

async function notifyTool(args) {
  const title = str(args.title) || 'Cairn';
  const message = requireStr(args, 'message');
  const data = await api('POST', '/api/assistant/notify', { title, message });
  return macOutcome(data, `Notification shown: "${title}" — ${message}`);
}

async function appleReminder(args) {
  const title = requireStr(args, 'title');
  const due = args.due ? requireIso(args, 'due') : undefined;
  const body = compact({ title, due, list: optStr(args.list), notes: optStr(args.notes) });
  const data = await api('POST', '/api/assistant/mac/reminder', body, { timeoutMs: 150_000 });
  const listName = data?.list || data?.result?.list || body.list || 'default list';
  return macOutcome(data, `Added "${title}" to the Reminders app (${listName})${due ? `, due ${fmtDate(due)}` : ''}.`);
}

async function calendarEvent(args) {
  const title = requireStr(args, 'title');
  const start = requireIso(args, 'start');
  const end = args.end ? requireIso(args, 'end') : undefined;
  if (end && new Date(end) <= new Date(start)) throw new ToolError('"end" must be after "start".');
  const body = compact({ title, start, end, calendar: optStr(args.calendar), location: optStr(args.location), notes: optStr(args.notes) });
  const data = await api('POST', '/api/assistant/mac/calendar', body, { timeoutMs: 150_000 });
  const cal = data?.calendar || data?.result?.calendar || body.calendar || 'default calendar';
  return macOutcome(data, `Created Calendar event "${title}" on ${fmtDate(start)}${end ? ` until ${fmtDate(end)}` : ' (1 hour)'} in ${cal}.`);
}

async function openUrlTool(args) {
  const raw = requireStr(args, 'url');
  const url = safeHttpUrl(raw);
  if (!url) throw new ToolError('Only absolute http:// or https:// URLs can be opened.');
  const data = await api('POST', '/api/assistant/open', { url });
  return macOutcome(data, `Opened ${url} in the user's default browser.`);
}

async function openAppTool(args) {
  const name = requireStr(args, 'name');
  const data = await api('POST', '/api/assistant/open', { app: name });
  return macOutcome(data, `Opened the ${name} app.`);
}

async function webResearch(args) {
  const query = requireStr(args, 'query');
  const limit = clampInt(args.limit, 1, 20, 8);
  const data = await api('POST', '/api/search', { query, limit });
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return textResult(`The local Cairn index has nothing for "${query}". Use WebSearch for live web results (and WebFetch or the browser to read pages).`);
  const lines = [`${results.length} result(s) from the local Cairn index for "${query}" (may be stale — use WebSearch for current prices/news):`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || '(untitled)'}`, `   ${r.url}`);
    if (r.snippet) lines.push(`   ${String(r.snippet).slice(0, 400)}`);
  });
  return textResult(lines.join('\n'));
}

function describeItem(it) {
  const bits = [`[${it.id}] ${it.item || it.name || '(item)'}`];
  if (it.price !== undefined && it.price !== null && it.price !== '') bits.push(String(it.price));
  if (it.store) bits.push(it.store);
  if (it.url) bits.push(it.url);
  if (it.notes) bits.push(`notes: ${it.notes}`);
  return bits.join(' — ');
}

async function shoppingAdd(args) {
  const item = requireStr(args, 'item');
  let url;
  if (args.url) {
    url = safeHttpUrl(str(args.url));
    if (!url) throw new ToolError('"url" must be an absolute http(s) link to the product page.');
  }
  const price = args.price === undefined || args.price === null || args.price === '' ? undefined : String(args.price).trim();
  const body = compact({ item, url, price, store: optStr(args.store), notes: optStr(args.notes) });
  const data = await api('POST', '/api/assistant/shopping', body);
  const saved = data.item || { ...body, id: data.id };
  return textResult(`Added to the shopping list: ${describeItem(saved)}`);
}

async function shoppingList() {
  const data = await api('GET', '/api/assistant/shopping');
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return textResult('The shopping list is empty.');
  return textResult([`Shopping list (${items.length}):`, ...items.map(describeItem)].join('\n'));
}

async function shoppingRemove(args) {
  const id = requireStr(args, 'id', 'Call shopping_list to find the id.');
  await api('DELETE', `/api/assistant/shopping/${encodeURIComponent(id)}`, {});
  return textResult(`Removed item ${id} from the shopping list.`);
}

async function clipboardRead() {
  const data = await api('POST', '/api/assistant/clipboard', { op: 'read' });
  const r = data?.result && typeof data.result === 'object' ? data.result : data;
  if (r?.ok === false) throw new ToolError(r.error || 'Could not read the clipboard.');
  const text = String(r?.text ?? '');
  return textResult(text ? `Clipboard contents:\n${text.length > 20000 ? text.slice(0, 20000) + '\n…(truncated)' : text}` : 'The clipboard is empty (or holds no text).');
}

async function clipboardWrite(args) {
  if (args?.text === undefined || args?.text === null) throw new ToolError('"text" is required.');
  const text = String(args.text);
  const data = await api('POST', '/api/assistant/clipboard', { op: 'write', text });
  return macOutcome(data, `Copied ${text.length} character(s) to the clipboard.`);
}

// ---------- approval_prompt (permission prompt tool) ----------
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

const deny = (message) => textResult(JSON.stringify({ behavior: 'deny', message }));

async function approvalPrompt(args, ctx = {}) {
  const toolName = str(args?.tool_name ?? args?.toolName) || 'unknown tool';
  const input = args?.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : {};
  const signal = ctx.signal;
  let created;
  try {
    created = await api('POST', '/api/assistant/approvals', compact({ toolName, input, conversationId: CONVERSATION_ID, runId: RUN_ID, toolUseId: optStr(args?.tool_use_id) }), { signal });
  } catch (e) {
    return deny(`Could not ask the user for approval (${e.message}). The ${toolName} action was NOT performed; tell the user what you wanted to do so they can do it or approve it later.`);
  }
  const id = created?.id || created?.approval?.id;
  if (!id) return deny(`Cairn did not create an approval request; the ${toolName} action was NOT performed.`);

  const limit = UNATTENDED ? Math.min(MAX_MS, UNATTENDED_MS) : MAX_MS;
  const started = Date.now();
  const deadline = started + limit;
  let polls = 0;
  while (Date.now() < deadline && !signal?.aborted) {
    const windowMs = Math.max(1, Math.min(POLL_MS, deadline - Date.now()));
    const pollStart = Date.now();
    let data = null;
    try {
      data = await api('GET', `/api/assistant/approvals/${encodeURIComponent(id)}/wait?timeout=${Math.max(1, Math.ceil(windowMs / 1000))}`, undefined, {
        timeoutMs: windowMs + 15_000,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) break;
      if (/HTTP 404/.test(e.message)) return deny(`The approval request expired or was removed; the ${toolName} action was NOT performed.`);
      log(`approval ${id} wait failed: ${e.message}`);
    }
    polls++;
    ctx.progress?.(polls, `Waiting for the user to approve ${toolName}`);
    if (data?.decided) {
      const d = data.decision || {};
      if (d.allow) {
        const updatedInput = d.updatedInput && typeof d.updatedInput === 'object' && !Array.isArray(d.updatedInput) ? d.updatedInput : input;
        return textResult(JSON.stringify({ behavior: 'allow', updatedInput }));
      }
      // Say plainly that the USER declined in Cairn (not a sandbox/settings restriction), so the model reports it
      // correctly instead of suggesting the user edit Claude Code permission settings.
      const why = str(d.message);
      return deny(`The user denied permission to use ${toolName} in Cairn${why ? ` and said: "${why}"` : ''}. The action was NOT performed. Do not retry it or work around it, and do not suggest changing Claude Code settings; tell the user it was not done and ask how they would like to proceed.`);
    }
    // The server answered "not yet" faster than the long-poll window (or failed):
    // back off briefly instead of hammering it.
    const elapsed = Date.now() - pollStart;
    if (elapsed < windowMs) await sleep(Math.min(1000, windowMs - elapsed, Math.max(0, deadline - Date.now())), signal);
  }
  if (signal?.aborted) return deny('The approval request was cancelled.');
  const mins = Math.max(1, Math.round(limit / 60_000));
  return deny(
    UNATTENDED
      ? `This is an unattended background run and the user did not approve ${toolName} within ${mins} minute(s); the action was NOT performed. Do not retry it — finish what you can and state in your final answer which step needs the user's approval.`
      : `No response from the user within ${mins} minute(s) (timed out); the ${toolName} action was NOT performed. Do not retry it automatically — tell the user what you wanted to do.`,
  );
}

// ---------- tool catalogue ----------
const ISO_HINT = 'ISO 8601 local time with offset, e.g. "2026-10-01T09:00:00-07:00" (or without offset = local time). Always compute an exact date-time from the current local date/time you were given; never pass phrases like "tomorrow".';
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'schedule_task',
    title: 'Schedule a reminder or background task',
    description:
      'Schedule a Cairn reminder or a recurring/one-off background agent task. This is THE tool for "remind me…", "ping me in 20 minutes", "every weekday at 9 tell me…", and for "every morning at 8 check X and tell me". ' +
      'kind "reminder" (default): at the time Cairn shows a macOS notification plus an alert in the Cairn bubble with the title/notes. ' +
      'kind "agent": at the time Cairn runs the assistant unattended in the background with `prompt` (write it as a complete, self-contained instruction, e.g. "Search for the price of the Sony WH-1000XM5 at major US stores and summarise the cheapest three") and notifies the user with the result. ' +
      'For repeating items give `when` as the first occurrence and set `recurrence`. Only use apple_reminder instead when the user explicitly asks for the Apple Reminders app. Confirm the scheduled local time back to the user.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Short title shown in the notification, e.g. "Call mom" or "Daily AI news digest".' },
        when: { type: 'string', description: `First (or only) time it fires. ${ISO_HINT}` },
        kind: { type: 'string', enum: ['reminder', 'agent'], default: 'reminder', description: '"reminder" = just notify; "agent" = run `prompt` as a background assistant task and report the result.' },
        prompt: { type: 'string', description: 'Required for kind "agent": the full instruction to execute at that time.' },
        notes: { type: 'string', description: 'Optional extra detail shown with the reminder.' },
        recurrence: {
          type: 'object',
          description: 'Omit for one-shot. Examples: every day at 08:00 → {"every":"day","at":"08:00"}; weekdays at 09:00 → {"every":"weekday","at":"09:00"}; Mon & Thu → {"every":"week","days":["mon","thu"],"at":"18:00"}; every 30 minutes → {"every":"minute","interval":30}.',
          properties: {
            every: { type: 'string', enum: EVERY },
            interval: { type: 'integer', minimum: 1, description: 'Every N units (default 1).' },
            at: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$', description: 'Local 24-hour time "HH:MM" for day/week/weekday recurrences.' },
            days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'Restrict to these weekdays.' },
          },
          required: ['every'],
          additionalProperties: false,
        },
      },
      ['title', 'when'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: scheduleTask,
  },
  {
    name: 'list_tasks',
    title: 'List scheduled reminders and tasks',
    description: 'List the upcoming Cairn reminders and scheduled/recurring background tasks with their ids and next run times. Use it when the user asks what is scheduled, and before cancel_task to find the id.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: listTasks,
  },
  {
    name: 'cancel_task',
    title: 'Cancel a scheduled reminder or task',
    description: 'Cancel (delete) a Cairn reminder or scheduled task by id. Get the id from list_tasks first if you do not have it; if several match the user\'s description, ask which one.',
    inputSchema: obj({ id: { type: 'string', description: 'Task id from list_tasks / schedule_task.' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: cancelTask,
  },
  {
    name: 'notify',
    title: 'Show a macOS notification now',
    description: 'Show a macOS notification on the user\'s Mac immediately (e.g. to flag that a long task finished or something important was found). For anything in the future use schedule_task instead.',
    inputSchema: obj({ title: { type: 'string', description: 'Notification title (default "Cairn").' }, message: { type: 'string', description: 'Notification body, one or two short sentences.' } }, ['message']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: notifyTool,
  },
  {
    name: 'apple_reminder',
    title: 'Add to the Apple Reminders app',
    description: 'Create an item in the Apple Reminders app (syncs to the user\'s iPhone via iCloud). Use ONLY when the user explicitly mentions the Reminders app, their iPhone reminders, or a Reminders list (e.g. "add milk to my Groceries list in Reminders"). For ordinary "remind me…" requests use schedule_task.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Reminder text.' },
        due: { type: 'string', description: `Optional due date-time (also sets the alert). ${ISO_HINT}` },
        list: { type: 'string', description: 'Reminders list name; falls back to the default list if it does not exist.' },
        notes: { type: 'string', description: 'Optional notes.' },
      },
      ['title'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: appleReminder,
  },
  {
    name: 'calendar_event',
    title: 'Add an event to Apple Calendar',
    description: 'Create an event in the Apple Calendar app. Use when the user asks to put something on their calendar / book a time block / add a meeting or appointment. If only a start is known the event lasts 1 hour. Does not invite attendees or send any email. Confirm date and time back to the user.',
    inputSchema: obj(
      {
        title: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: `Start. ${ISO_HINT}` },
        end: { type: 'string', description: 'Optional end (ISO 8601, same format; default start + 1 hour).' },
        calendar: { type: 'string', description: 'Calendar name (default: the first writable calendar).' },
        location: { type: 'string', description: 'Optional location.' },
        notes: { type: 'string', description: 'Optional notes/description.' },
      },
      ['title', 'start'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: calendarEvent,
  },
  {
    name: 'open_url',
    title: "Open a link in the user's browser",
    description: "Open an http(s) URL in the user's own default browser so they can see it — e.g. to hand off checkout (\"here is your cart, please review and pay yourself\"), show a found page, or open a map. This does not let you read or control the page; use the browser tools or WebFetch for that.",
    inputSchema: obj({ url: { type: 'string', description: 'Absolute http:// or https:// URL.' } }, ['url']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: openUrlTool,
  },
  {
    name: 'open_app',
    title: 'Launch a Mac app',
    description: 'Launch or bring to front a macOS application by name (e.g. "Notes", "Safari", "Spotify", "Visual Studio Code") when the user asks to open an app.',
    inputSchema: obj({ name: { type: 'string', description: 'Application name as shown in /Applications, without ".app".' } }, ['name']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: openAppTool,
  },
  {
    name: 'web_research',
    title: 'Search the local Cairn index',
    description: 'Search pages already saved in the user\'s local Cairn web index (things crawled or read before). Fast and private, but may be stale or empty — for anything current (news, prices, availability, opening hours) ALSO use the built-in WebSearch tool, then read the best pages with WebFetch or the browser. Cite the URLs you rely on.',
    inputSchema: obj({ query: { type: 'string', description: 'Search keywords.' }, limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 8).' } }, ['query']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: webResearch,
  },
  {
    name: 'shopping_list_add',
    title: 'Add to the Cairn shopping list',
    description: 'Save a product to the user\'s Cairn shopping list (shown in the bubble\'s Shopping tab). Use after researching/comparing products when the user wants to keep or buy one, including the product link, price and store you found. This never buys anything. NEVER place orders or enter payment, address or card details anywhere — hand checkout to the user with the link.',
    inputSchema: obj(
      {
        item: { type: 'string', description: 'Product name / description, e.g. "Sony WH-1000XM5 headphones (black)".' },
        url: { type: 'string', description: 'Product page URL (http/https).' },
        price: { type: 'string', description: 'Price as seen, with currency, e.g. "$329.99".' },
        store: { type: 'string', description: 'Store / seller, e.g. "Best Buy".' },
        notes: { type: 'string', description: 'Optional notes (size, colour, why it was chosen, deal expiry…).' },
      },
      ['item'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: shoppingAdd,
  },
  {
    name: 'shopping_list',
    title: 'Show the Cairn shopping list',
    description: 'List the items on the user\'s Cairn shopping list with ids, prices, stores and links.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: shoppingList,
  },
  {
    name: 'shopping_list_remove',
    title: 'Remove from the Cairn shopping list',
    description: 'Remove an item from the Cairn shopping list by id (get ids from shopping_list), e.g. when the user bought it or no longer wants it.',
    inputSchema: obj({ id: { type: 'string', description: 'Item id from shopping_list.' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: shoppingRemove,
  },
  {
    name: 'clipboard_read',
    title: "Read the Mac's clipboard",
    description: 'Read the current text on the user\'s clipboard. Only use when the user refers to something they copied ("summarise what I copied", "use the link in my clipboard"). Requires the user\'s approval each time.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: clipboardRead,
  },
  {
    name: 'clipboard_write',
    title: "Copy text to the Mac's clipboard",
    description: 'Put text on the user\'s clipboard so they can paste it (e.g. a drafted email, a command, an address). Replaces the current clipboard contents; mention that you did it.',
    inputSchema: obj({ text: { type: 'string', description: 'Exact text to copy.' } }, ['text']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: clipboardWrite,
  },
  {
    name: 'approval_prompt',
    title: 'Ask the user to approve a tool call (internal)',
    description:
      'Internal permission check used automatically by Cairn (--permission-prompt-tool) before risky actions such as shell commands, file edits or browser clicks; it asks the user in the Cairn bubble and waits for Approve/Deny. Do NOT call this tool yourself — just call the tool you need and Cairn will ask the user.',
    inputSchema: obj(
      {
        tool_name: { type: 'string', description: 'Name of the tool that needs permission.' },
        input: { type: 'object', description: 'The input the tool would be called with.', additionalProperties: true },
        tool_use_id: { type: 'string', description: 'Tool use id, if known.' },
      },
      ['tool_name', 'input'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: approvalPrompt,
  },
];
// The CLI may send extra fields to the permission tool in future versions.
TOOLS.find((t) => t.name === 'approval_prompt').inputSchema.additionalProperties = true;

export const TOOL_NAMES = TOOLS.map((t) => t.name);

// ---------- JSON-RPC ----------
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const inflight = new Map(); // request id → AbortController

async function dispatch(method, params, id) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'assistant', title: 'Cairn personal assistant tools', version: '1.0.0' },
        instructions:
          'Cairn personal-assistant tools for the user\'s Mac. Use schedule_task for reminders and recurring/background tasks (exact ISO local times); apple_reminder / calendar_event only when the user wants the Reminders / Calendar apps; shopping_list_* to keep products (never buy or pay); open_url to hand pages to the user. approval_prompt is internal — never call it.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
      const controller = new AbortController();
      inflight.set(id, controller);
      const progressToken = params?._meta?.progressToken;
      const progress =
        progressToken !== undefined
          ? (n, message) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message } })
          : null;
      try {
        return await tool.handler(params.arguments || {}, { signal: controller.signal, progress });
      } catch (e) {
        if (!(e instanceof ToolError)) log(`tool ${tool.name} crashed:`, e.stack || e.message);
        return textResult(`${tool.name} failed: ${e.message}`, true);
      } finally {
        inflight.delete(id);
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.method === undefined && ('result' in msg || 'error' in msg)) return null;
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (msg.id === undefined) {
    if (msg.method === 'notifications/cancelled') inflight.get(msg.params?.requestId)?.abort();
    return null;
  }
  try {
    const result = await dispatch(msg.method, msg.params, msg.id);
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    if (!(e instanceof RpcError)) log('internal error:', e.stack || e.message);
    return { jsonrpc: '2.0', id: msg.id, error: { code, message: e.message } };
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) {
    if (!msg.length) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    const replies = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
    if (replies.length) send(replies);
    return;
  }
  const reply = await handleMessage(msg);
  if (reply) send(reply);
}

function main() {
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const p = handleLine(line).catch((e) => log('unhandled:', e.stack || e.message));
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  rl.on('close', async () => {
    // Client went away: abort approval waits, let other calls finish briefly, exit.
    for (const c of inflight.values()) c.abort();
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 3000).unref())]);
    process.exit(0);
  });
  process.stdout.on('error', () => process.exit(0));
  log(`ready (api ${API}${UNATTENDED ? ', unattended' : ''}${RUN_ID ? `, run ${RUN_ID}` : ''})`);
}

// Run as a server only when executed directly (importing just exposes TOOL_NAMES).
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();
