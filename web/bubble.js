// Cairn Assistant bubble: the compact, always-on assistant panel that the native
// floating bubble (desktop/CairnBubble.swift) shows in a WKWebView. It also works
// full-page in a normal browser at /web/bubble.html.
//
// Every request runs as a background job on the server. Sending a message never
// blocks the composer; the chat view just follows the selected run, and the
// Activity tab lists every background run.
//
// Security: server data only reaches the DOM through textContent, attributes and
// validated hrefs. The single innerHTML sink is renderMarkdown(), which escapes
// every piece of source text before wrapping it in a small whitelist of tags, and
// only emits links whose URL is http(s).
//
// The pure helpers are exported so they can be unit-tested under Node. The UI
// boots only when a DOM is present.

const API = '/api/assistant';
const STORE_CONV = 'cairn.bubble.conversationId';
const STORE_TAB = 'cairn.bubble.tab';
const TABS = ['chat', 'activity', 'tasks', 'shopping', 'history'];
const RUN_EVENT_TYPES = ['status', 'text', 'tool', 'tool_result', 'approval', 'approval_resolved', 'result', 'error', 'done', 'state', 'queued', 'started'];
const GLOBAL_EVENT_TYPES = ['hello', 'reminder', 'task_result', 'task_started', 'task_error', 'tasks_changed', 'shopping_changed', 'notification', 'approval', 'approval_resolved', 'run_started', 'run_update', 'run_done'];
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const BG_TOAST = "Working on it in the background — I'll notify you when done";

/* ================================================================ pure helpers */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const UNESC_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function unescapeHtml(value) {
  return String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => UNESC_MAP[e]);
}

/** Absolute http(s) URL → normalised href, anything else → null. */
export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Like safeUrl but also allows same-origin absolute paths ("/docs/"). */
function safeHref(raw) {
  const s = String(raw ?? '').trim();
  if (/^\/(?!\/)/.test(s) && !/[\s\\]/.test(s)) return s;
  return safeUrl(s);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function truncate(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}

/** Rough markdown → plain text, for toasts and one-line previews. */
export function plainText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ')
    // Table separators that were already flattened onto one line (run summaries): "| --- | :--: |".
    .replace(/(^|[\s|]):?-{2,}:?(?=[\s|…]|$)/g, '$1 ')
    .replace(/[*_~`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : null;
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(String(value));
  return Number.isNaN(n) ? null : n;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 0.001) return '<$0.001';
  return `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today 5:00 PM", "Tomorrow 9:00 AM", "Fri 10:00 AM", "Oct 12, 9:00 AM". */
export function formatWhen(ms, now = Date.now()) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86400000);
  const clock = formatClock(ms);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  const d = new Date(ms);
  if (Math.abs(days) < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })}, ${clock}`;
}

export function timeUntil(ms, now = Date.now()) {
  if (ms === null || ms === undefined) return '';
  const diff = ms - now;
  if (diff < -60000) return 'overdue';
  if (diff < 60000) return 'any moment';
  const m = Math.round(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function timeAgo(ms, now = Date.now()) {
  if (ms === null || ms === undefined) return '';
  const diff = now - ms;
  if (diff < 45000) return 'just now';
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  if (h < 48) return 'yesterday';
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatHHMM(at) {
  const m = String(at ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(at ?? '');
  const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
  return formatClock(d.getTime());
}

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** Human label for a scheduler recurrence object. */
export function recurrenceLabel(rec) {
  if (!rec || typeof rec !== 'object' || !rec.every) return '';
  const n = Math.max(1, Number(rec.interval) || 1);
  const at = rec.at ? ` at ${formatHHMM(rec.at)}` : '';
  const days = Array.isArray(rec.days) && rec.days.length
    ? rec.days.map((d) => DAY_NAMES[String(d).slice(0, 3).toLowerCase()] || String(d)).join(', ')
    : '';
  switch (rec.every) {
    case 'minute':
      return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    case 'hour':
      return n === 1 ? 'Every hour' : `Every ${n} hours`;
    case 'day':
      return `${days ? `Every ${days}` : n === 1 ? 'Every day' : `Every ${n} days`}${at}`;
    case 'weekday':
      return `Every weekday${at}`;
    case 'week':
      return `${n === 1 ? 'Every week' : `Every ${n} weeks`}${days ? ` on ${days}` : ''}${at}`;
    default:
      return `Repeats (${String(rec.every)})`;
  }
}

/* ------------------------------------------------------------ run state model */

export const RUN_STATES = {
  queued: { label: 'Queued', cls: 's-queued' },
  running: { label: 'Running', cls: 's-running' },
  waiting_approval: { label: 'Needs approval', cls: 's-waiting' },
  done: { label: 'Done', cls: 's-done' },
  error: { label: 'Error', cls: 's-error' },
  cancelled: { label: 'Cancelled', cls: 's-cancelled' },
};

export function isActiveState(state) {
  return state === 'queued' || state === 'running' || state === 'waiting_approval';
}

/** Normalise a run summary from /runs or a run_* event; only defined fields are kept. */
export function normalizeRun(raw) {
  const r = raw && typeof raw === 'object' ? (raw.run && typeof raw.run === 'object' ? { ...raw, ...raw.run } : raw) : {};
  const out = {};
  const runId = r.runId ?? r.id;
  if (runId !== undefined && runId !== null) out.runId = String(runId);
  if (r.conversationId) out.conversationId = String(r.conversationId);
  if (r.title) out.title = String(r.title);
  if (r.state) out.state = String(r.state);
  const startedAt = toMs(r.startedAt);
  if (startedAt) out.startedAt = startedAt;
  const finishedAt = toMs(r.finishedAt);
  if (finishedAt) out.finishedAt = finishedAt;
  if (r.lastEvent) out.lastEvent = String(r.lastEvent);
  if (r.costUsd !== undefined && r.costUsd !== null) out.costUsd = Number(r.costUsd);
  if (r.error) out.error = typeof r.error === 'string' ? r.error : r.error.message || 'Error';
  return out;
}

/* ---------------------------------------------------------- tool descriptions */

export function splitToolName(name) {
  const s = String(name ?? '');
  const m = s.match(/^mcp__(.+?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : { server: null, tool: s };
}

function base(p) {
  const s = String(p ?? '').replace(/\/+$/, '');
  return s.split('/').pop() || s;
}

const ASSISTANT_TOOLS = {
  schedule_task: (i) => ['⏰', `Scheduled “${truncate(i.title || 'task', 40)}”`],
  list_tasks: () => ['📋', 'Checking your tasks'],
  cancel_task: () => ['🗑️', 'Cancelling a task'],
  notify: (i) => ['🔔', `Notification: ${truncate(i.title || i.message || '', 40)}`],
  apple_reminder: (i) => ['✅', `Reminders: ${truncate(i.title || '', 40)}`],
  calendar_event: (i) => ['📅', `Calendar: ${truncate(i.title || '', 40)}`],
  open_url: (i) => ['🔗', `Opening ${hostOf(i.url) || 'a link'}`],
  open_app: (i) => ['🖥️', `Opening ${truncate(i.name || 'an app', 30)}`],
  web_research: (i) => ['🔎', `Searching: ${truncate(i.query || '', 44)}`],
  shopping_list_add: (i) => ['🛒', `Added to list: ${truncate(i.item || '', 36)}`],
  shopping_list: () => ['🛒', 'Checking shopping list'],
  shopping_list_remove: () => ['🛒', 'Removing from shopping list'],
  clipboard_read: () => ['📋', 'Reading clipboard'],
  clipboard_write: () => ['📋', 'Copying to clipboard'],
  approval_prompt: () => ['🛡️', 'Asking for approval'],
};

const CAIRN_TOOLS = {
  search_index: (i) => ['🔎', `Searching index: ${truncate(i.query || i.q || '', 40)}`],
  fetch_page: (i) => ['📄', `Reading ${hostOf(i.url) || 'a page'}`],
  check_robots: (i) => ['🤖', `Checking robots.txt${hostOf(i.url) ? ` for ${hostOf(i.url)}` : ''}`],
  index_stats: () => ['📊', 'Checking index stats'],
  crawl_site: (i) => ['🕸️', `Crawling ${hostOf(i.url || (i.seeds || [])[0]) || 'a site'}`],
};

const BUILTIN_TOOLS = {
  WebSearch: (i) => ['🔎', `Searching the web: ${truncate(i.query || '', 40)}`],
  WebFetch: (i) => ['📄', `Reading ${hostOf(i.url) || 'a page'}`],
  Bash: (i) => ['💻', `Terminal: ${truncate(i.command || '', 48)}`],
  Read: (i) => ['📂', `Reading ${truncate(base(i.file_path || i.path), 40)}`],
  Glob: (i) => ['📂', `Finding files: ${truncate(i.pattern || '', 36)}`],
  Grep: (i) => ['🔍', `Searching files for “${truncate(i.pattern || '', 30)}”`],
  LS: (i) => ['📂', `Listing ${truncate(base(i.path), 40)}`],
  Write: (i) => ['✏️', `Writing ${truncate(base(i.file_path), 40)}`],
  Edit: (i) => ['✏️', `Editing ${truncate(base(i.file_path), 40)}`],
  MultiEdit: (i) => ['✏️', `Editing ${truncate(base(i.file_path), 40)}`],
  NotebookEdit: (i) => ['✏️', `Editing ${truncate(base(i.notebook_path), 40)}`],
  TodoWrite: () => ['📝', 'Planning steps'],
  Task: () => ['🤖', 'Delegating to a helper'],
  Agent: () => ['🤖', 'Delegating to a helper'],
};

function browserStep(tool, i) {
  const action = tool.replace(/^browser_/, '').replace(/_/g, ' ');
  let detail = '';
  if (tool === 'browser_navigate') detail = hostOf(i.url);
  else if (tool === 'browser_click' || tool === 'browser_hover') detail = truncate(i.element || '', 36);
  else if (tool === 'browser_type') detail = `“${truncate(i.text || '', 28)}”`;
  else if (tool === 'browser_select_option') detail = truncate((i.values || []).join(', '), 30);
  else if (tool === 'browser_take_screenshot') return ['📸', 'Browser: screenshot'];
  else if (tool === 'browser_snapshot') return ['👀', 'Browser: reading the page'];
  return ['🌐', `Browser: ${action}${detail ? ` ${detail}` : ''}`];
}

/** {icon, label, pretty} for a tool call, used by step chips and approval cards. */
export function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const { server, tool } = splitToolName(name);
  let pair = null;
  try {
    if (server === 'assistant' && ASSISTANT_TOOLS[tool]) pair = ASSISTANT_TOOLS[tool](i);
    else if (server === 'cairn' && CAIRN_TOOLS[tool]) pair = CAIRN_TOOLS[tool](i);
    else if (server === 'playwright' || /^browser_/.test(tool)) pair = browserStep(tool, i);
    else if (!server && BUILTIN_TOOLS[tool]) pair = BUILTIN_TOOLS[tool](i);
  } catch {
    pair = null;
  }
  const pretty = prettyToolName(name);
  if (!pair) pair = ['🛠️', pretty];
  return { icon: pair[0], label: String(pair[1]).trim() || pretty, pretty };
}

export function prettyToolName(name) {
  const { server, tool } = splitToolName(name);
  const special = { Bash: 'Terminal', WebFetch: 'Web fetch', WebSearch: 'Web search', Write: 'Write file', Edit: 'Edit file', MultiEdit: 'Edit file', Read: 'Read file' };
  if (!server && special[tool]) return special[tool];
  const words = tool.replace(/^browser_/, server === 'playwright' ? 'browser ' : '').replace(/_/g, ' ').trim();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return server && server !== 'assistant' && server !== 'playwright' ? `${label} (${server})` : label;
}

/** Plain-text preview of a tool input for approval cards (always rendered via textContent). */
export function inputPreview(name, input, max = 900) {
  const i = input && typeof input === 'object' ? input : {};
  const { tool } = splitToolName(name);
  let out;
  if (tool === 'Bash' && i.command) out = `$ ${i.command}${i.description ? `\n# ${i.description}` : ''}`;
  else if (tool === 'Write' && i.file_path) out = `${i.file_path}\n\n${String(i.content ?? '').slice(0, 600)}`;
  else if ((tool === 'Edit' || tool === 'MultiEdit') && i.file_path) {
    out = i.old_string !== undefined ? `${i.file_path}\n- ${String(i.old_string).slice(0, 300)}\n+ ${String(i.new_string ?? '').slice(0, 300)}` : `${i.file_path}\n${JSON.stringify(i.edits ?? i, null, 2)}`;
  } else if (tool === 'browser_type' && i.text !== undefined) out = `${i.element ? `${i.element}: ` : ''}“${i.text}”${i.submit ? '  (then press Enter)' : ''}`;
  else if (tool === 'browser_click' && i.element) out = `Click: ${i.element}`;
  else {
    try {
      out = JSON.stringify(i, null, 2);
    } catch {
      out = String(i);
    }
  }
  out = String(out ?? '');
  return out.length > max ? `${out.slice(0, max)}\n… (${out.length - max} more characters)` : out;
}

/* ============================================================ markdown-lite */

const SLOT = '\u0000';
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function linkHtml(href, labelHtml, title = '') {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${t}>${labelHtml}</a>`;
}

/** Short, readable label for a bare URL: "host/path…". */
export function shortUrlLabel(href, max = 42) {
  try {
    const u = new URL(href);
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return truncate(`${u.hostname.replace(/^www\./, '')}${rest}`, max);
  } catch {
    return truncate(href, max);
  }
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])((?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])((?:[^_\n]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<del>$1</del>');
}

/** Inline markdown for ONE line of raw (unescaped) text → safe HTML. */
function inlineMd(raw) {
  const slots = [];
  const put = (html) => `${SLOT}${slots.push(html) - 1}${SLOT}`;
  // Escape first: everything below operates on escaped text only.
  let s = escapeHtml(String(raw ?? '').replace(/\u0000/g, ''));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => put(`<code>${code}</code>`));
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]*)[^)]*\)/g, (_, alt) => put(`<span class="md-img">[image${alt ? `: ${alt}` : ''}]</span>`));
  s = s.replace(/\[([^\]\n]+)\]\(\s*(?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?(?:\s+&quot;[^\n]*?&quot;)?\s*\)/gi, (m, label, url) => {
    const href = safeUrl(unescapeHtml(url));
    return href ? put(linkHtml(href, emphasis(label))) : m;
  });
  s = s.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/gi, (m, url) => {
    const href = safeUrl(unescapeHtml(url));
    return href ? put(linkHtml(href, url)) : m;
  });
  s = s.replace(/\bhttps?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s\u0000])+/gi, (m) => {
    let url = m;
    let tail = '';
    while (/[.,;:!?)\]}*_~]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    const href = safeUrl(unescapeHtml(url));
    return href ? put(linkHtml(href, escapeHtml(shortUrlLabel(href)), href)) + tail : m;
  });
  s = emphasis(s);
  for (let k = 0; k < 4 && s.includes(SLOT); k++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? '');
  return s;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableStart(line, next) {
  return line.includes('|') && next !== undefined && next.includes('|') && next.includes('-') && TABLE_SEP_RE.test(next);
}

function isBlockStart(line, next) {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || isTableStart(line, next);
}

function listItemHtml(text) {
  let body = text;
  let prefix = '';
  const task = body.match(/^\[([ xX])\]\s+([\s\S]*)$/);
  if (task) {
    prefix = `<span class="md-check${task[1] === ' ' ? '' : ' is-checked'}" aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span> `;
    body = task[2];
  }
  return prefix + body.split('\n').map(inlineMd).join('<br>');
}

function parseList(lines, start) {
  const items = [];
  const first = lines[start].match(LIST_RE);
  const rootIndent = first[1].replace(/\t/g, '    ').length;
  const rootOrdered = /\d/.test(first[2]);
  // A root-level item with the other marker kind (bullet vs number) starts a new list.
  const sameList = (m) => m[1].replace(/\t/g, '    ').length > rootIndent || /\d/.test(m[2]) === rootOrdered;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    if (m && !HR_RE.test(line)) {
      if (!sameList(m)) break;
      items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
      i++;
      continue;
    }
    if (!line.trim()) {
      const next = i + 1 < lines.length ? lines[i + 1].match(LIST_RE) : null;
      if (next && !HR_RE.test(lines[i + 1]) && sameList(next)) {
        i++;
        continue;
      }
      break;
    }
    if (/^\s{2,}\S/.test(line) && items.length && !isBlockStart(line.trim(), lines[i + 1])) {
      items[items.length - 1].text += `\n${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      const startAttr = it.ordered && it.start > 1 ? ` start="${it.start}"` : '';
      html += `<${tag} class="md-list"${startAttr}>`;
      stack.push({ indent: it.indent, tag });
    } else {
      html += '</li>';
    }
    html += `<li>${listItemHtml(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return [html, i];
}

/**
 * Markdown-lite → safe HTML string. Supports headings, bold/italic/strike, inline
 * and fenced code, ordered/unordered/task lists, blockquotes, tables and http(s)
 * links (opened in a new tab with rel=noopener). All text is escaped first.
 */
export function renderMarkdown(src, depth = 0) {
  const lines = String(src ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = line.match(FENCE_RE);
    if (m) {
      const fence = m[1];
      const close = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      const lang = m[2];
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    m = line.match(HEADING_RE);
    if (m) {
      const level = Math.min(6, m[1].length + 2);
      out.push(`<h${level} class="md-h">${inlineMd(m[2])}</h${level}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(QUOTE_RE, ''));
      out.push(depth < 4 ? `<blockquote>${renderMarkdown(buf.join('\n'), depth + 1)}</blockquote>` : `<blockquote><p>${buf.map(inlineMd).join('<br>')}</p></blockquote>`);
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : null));
      const cls = (j) => (aligns[j] ? ` class="al-${aligns[j]}"` : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const thead = `<tr>${head.map((c, j) => `<th${cls(j)}>${inlineMd(c)}</th>`).join('')}</tr>`;
      const tbody = rows.map((r) => `<tr>${head.map((_, j) => `<td${cls(j)}>${inlineMd(r[j] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const [html, next] = parseList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++].trim());
    out.push(`<p>${buf.map(inlineMd).join('<br>')}</p>`);
  }
  return out.join('');
}

/* ============================================================== DOM helpers */

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  minimize: 'M6 10l6 6 6-6',
  send: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
  stop: { d: 'M7 7h10v10H7z', fill: true },
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12.2A1 1 0 0 0 8 20h8a1 1 0 0 0 1-.8L18 7M9 7V4.5h6V7',
  play: { d: 'M8 5.5v13l10.5-6.5z', fill: true },
  x: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v10H9zM15 9V5H5v10h4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9M10 20.5a2 2 0 0 0 4 0',
  open: 'M9 6l6 6-6 6',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z',
  cart: 'M3 4h2.5l2.2 11h10.1l2-8H7M9.5 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  snooze: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
};

function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ico ico-${name}`);
  const def = ICONS[name] || ICONS.sparkle;
  const d = typeof def === 'string' ? def : def.d;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  if (typeof def === 'object' && def.fill) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== null && dv !== undefined) el.dataset[dk] = String(dv);
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'href') {
      const safe = safeHref(v);
      if (safe) el.setAttribute('href', safe);
    } else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** replaceChildren that skips null/false (the DOM would stringify them). */
function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

function btn(label, { icon: ic, cls = 'btn', title, onClick, disabled } = {}) {
  return h('button', { type: 'button', class: cls, title: title || null, 'aria-label': title || null, disabled: disabled || null, onclick: onClick }, ic ? icon(ic, 15) : null, label ? h('span', { text: label }) : null);
}

function iconBtn(ic, title, onClick, cls = '') {
  return h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), title, 'aria-label': title, onclick: onClick }, icon(ic, 16));
}

const $ = (sel, root = document) => root.querySelector(sel);

/* ============================================================== app state */

const S = {
  tab: 'chat',
  conversationId: null,
  viewToken: 0,
  runViews: new Map(), // runId → RunView (runs displayed in the current chat view)
  runs: new Map(), // runId → run summary (Activity)
  approvals: new Map(), // id → pending approval
  approvalCache: new Map(), // id → last known approval data (kept after resolution)
  resolved: new Map(), // id → 'approved' | 'denied' | 'expired'
  approvalBusy: new Set(),
  reminders: [], // alert banners: {key, kind, title, message, task, at}
  alertsExpanded: false, // show every banner instead of the newest MAX_VISIBLE_ALERTS
  tasks: [],
  shopping: [],
  conversations: [],
  health: null,
  online: null,
  globalLive: false,
  myRuns: new Set(),
  notifiedDone: new Set(),
  unseenDone: 0,
  booted: false,
};

function bridge() {
  try {
    return window.webkit?.messageHandlers?.cairn || null;
  } catch {
    return null;
  }
}

function isNative() {
  return Boolean(bridge());
}

/** Message the native shell (collapse / attention / ready). No-op in a browser. */
function postNative(msg) {
  const b = bridge();
  if (!b) return false;
  try {
    b.postMessage(msg);
    return true;
  } catch {
    return false;
  }
}

function storeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeSet(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable (private mode); the UI still works without it.
  }
}

function setConversationId(id) {
  S.conversationId = id || null;
  storeSet(STORE_CONV, S.conversationId);
  renderHistory();
}

/* ==================================================================== API */

async function api(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const init = { method, headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin', signal: ctrl?.signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    const err = new Error(e?.name === 'AbortError' ? 'The server took too long to answer' : 'Cannot reach the Cairn server');
    err.status = 0;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = (data && (typeof data.error === 'string' ? data.error : data.error?.message || data.message)) || `Request failed (HTTP ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data ?? {};
}

const enc = encodeURIComponent;

/* ================================================================= toasts */

function toast(message, { kind = 'info', action = null, timeout = 4500 } = {}) {
  const host = $('#toasts');
  if (!host) return null;
  while (host.children.length >= 3) host.firstElementChild.remove();
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  const el = h(
    'div',
    { class: `toast toast-${kind}` },
    h('span', { class: 'toast-text', text: message }),
    action ? btn(action.label, { cls: 'toast-action', onClick: () => { close(); action.fn(); } }) : null,
    iconBtn('x', 'Dismiss', close, 'toast-close'),
  );
  host.append(el);
  if (timeout) setTimeout(close, timeout);
  return el;
}

/* ======================================================== tabs & badges */

function showTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'chat';
  S.tab = name;
  storeSet(STORE_TAB, name);
  for (const t of TABS) {
    const tabEl = $(`#tab-${t}`);
    const view = $(`#view-${t}`);
    const on = t === name;
    tabEl?.classList.toggle('is-active', on);
    tabEl?.setAttribute('aria-selected', on ? 'true' : 'false');
    tabEl?.setAttribute('tabindex', on ? '0' : '-1');
    if (view) {
      view.hidden = !on;
      view.classList.toggle('is-active', on);
    }
  }
  if (focus) $(`#tab-${name}`)?.focus();
  if (name === 'activity') {
    S.unseenDone = 0;
    refreshRuns();
  } else if (name === 'tasks') refreshTasks();
  else if (name === 'shopping') refreshShopping();
  else if (name === 'history') refreshHistory();
  else if (name === 'chat') setTimeout(() => $('#composer-input')?.focus({ preventScroll: true }), 0);
  renderBadges();
}

function setBadge(id, count, { dot = false } = {}) {
  const el = $(id);
  if (!el) return;
  if (!count && !dot) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = count ? String(count > 99 ? '99+' : count) : '';
  el.classList.toggle('is-dot', !count && dot);
}

function activeRuns() {
  return [...S.runs.values()].filter((r) => isActiveState(r.state));
}

function renderBadges() {
  setBadge('#badge-chat', S.approvals.size);
  const active = activeRuns().length;
  setBadge('#badge-activity', active, { dot: S.unseenDone > 0 && S.tab !== 'activity' });
  $('#badge-activity')?.classList.toggle('is-live', active > 0);
  setBadge('#badge-tasks', S.tasks.filter((t) => (t.status || 'active') === 'active').length);
  setBadge('#badge-shopping', S.shopping.length);
  document.title = S.approvals.size ? `(${S.approvals.size}) Cairn Assistant` : 'Cairn Assistant';
}

/* ================================================================= health */

function setOnline(ok) {
  if (S.online === ok) return;
  const was = S.online;
  S.online = ok;
  renderHealth();
  if (ok && was === false) {
    toast('Reconnected to Cairn', { kind: 'success', timeout: 2500 });
    resync();
  }
}

async function refreshHealth() {
  try {
    S.health = await api(`${API}/health`, { timeoutMs: 8000 });
    setOnline(true);
  } catch (e) {
    if (e.status === 0) setOnline(false);
    else {
      S.health = { ok: false, error: e.message, status: e.status };
      setOnline(true);
    }
  }
  renderHealth();
}

function claudeAvailable(hh) {
  if (!hh || hh.claude === undefined || hh.claude === null) return true;
  if (typeof hh.claude === 'object') return hh.claude.available !== false;
  return hh.claude !== false;
}

function renderHealth() {
  const dot = $('#health-dot');
  const status = $('#hdr-status');
  if (!dot || !status) return;
  const hh = S.health || {};
  // With the live event stream up, local state is fresher than the last health poll.
  const localRunning = activeRuns().filter((r) => r.state !== 'queued').length;
  const localQueued = activeRuns().filter((r) => r.state === 'queued').length;
  const running = S.globalLive ? localRunning : Number(hh.runningRuns ?? localRunning) || 0;
  const queued = S.globalLive ? localQueued : Number(hh.queuedRuns ?? localQueued) || 0;
  const pending = S.globalLive ? S.approvals.size : Math.max(Number(hh.pendingApprovals) || 0, S.approvals.size);
  let cls = 'is-ok';
  let text = 'Ready · always on';
  let title = 'Cairn is running';
  if (S.online === false) {
    cls = 'is-offline';
    text = 'Offline — reconnecting…';
    title = 'Cannot reach the Cairn server';
  } else if (S.online === null) {
    cls = 'is-unknown';
    text = 'Connecting…';
    title = 'Checking server health';
  } else if (hh.status === 404) {
    cls = 'is-warn';
    text = 'Assistant API not available';
    title = 'The server is up but /api/assistant is not wired';
  } else if (!claudeAvailable(hh)) {
    cls = 'is-warn';
    text = 'Claude CLI not found';
    title = 'Install or log in to the Claude CLI';
  } else if (pending) {
    cls = 'is-attn';
    text = `${pending} approval${pending === 1 ? '' : 's'} waiting for you`;
  } else if (running || queued) {
    cls = 'is-busy';
    text = `${running} task${running === 1 ? '' : 's'} running${queued ? ` · ${queued} queued` : ''}`;
  } else {
    const next = toMs(hh.nextTaskAt);
    if (next) text = `Ready · next reminder ${timeUntil(next)}`;
  }
  dot.className = `health-dot ${cls}`;
  dot.setAttribute('aria-label', title);
  dot.title = title;
  status.textContent = text;
}

/* ============================================================ approvals */

function normalizeApproval(raw) {
  const a = raw && typeof raw === 'object' ? (raw.approval && typeof raw.approval === 'object' ? raw.approval : raw) : null;
  if (!a || a.id === undefined || a.id === null) return null;
  return { ...a, id: String(a.id), createdAt: toMs(a.createdAt) || Date.now() };
}

function upsertApproval(raw, { notify = false } = {}) {
  const a = normalizeApproval(raw);
  if (!a || S.resolved.has(a.id)) return null;
  const isNew = !S.approvals.has(a.id);
  const merged = { ...(S.approvals.get(a.id) || {}), ...a };
  S.approvals.set(a.id, merged);
  cacheApproval(merged);
  if (a.runId && S.runs.has(String(a.runId))) {
    const run = S.runs.get(String(a.runId));
    if (isActiveState(run.state)) run.state = 'waiting_approval';
  }
  if (isNew && notify) {
    const d = describeTool(a.toolName, a.input);
    postNative({ type: 'attention', title: 'Cairn needs your approval', message: a.summary || d.label });
  }
  renderAlerts();
  renderBadges();
  renderHealth();
  scheduleActivityRender();
  return a;
}

function cacheApproval(a) {
  S.approvalCache.set(a.id, a);
  if (S.approvalCache.size > 200) S.approvalCache.delete(S.approvalCache.keys().next().value);
}

function markApprovalResolved(id, outcome) {
  const key = String(id);
  const a = S.approvals.get(key);
  S.approvals.delete(key);
  S.resolved.set(key, outcome);
  if (S.resolved.size > 200) S.resolved.delete(S.resolved.keys().next().value);
  if (a?.runId && S.runs.has(String(a.runId))) {
    const run = S.runs.get(String(a.runId));
    const stillWaiting = [...S.approvals.values()].some((x) => String(x.runId) === String(a.runId));
    if (run.state === 'waiting_approval' && !stillWaiting) run.state = 'running';
  }
  for (const card of document.querySelectorAll('.approval-card')) {
    if (card.dataset.approvalId === key) applyApprovalOutcome(card, outcome);
  }
  renderAlerts();
  renderBadges();
  renderHealth();
  scheduleActivityRender();
}

async function refreshApprovals() {
  try {
    const d = await api(`${API}/approvals`);
    const list = Array.isArray(d.pending) ? d.pending : Array.isArray(d) ? d : [];
    const ids = new Set();
    for (const raw of list) {
      const a = upsertApproval(raw);
      if (a) ids.add(a.id);
    }
    for (const id of [...S.approvals.keys()]) if (!ids.has(id)) markApprovalResolved(id, S.resolved.get(id) || 'expired');
  } catch {
    // Health reporting covers connectivity problems.
  }
}

async function decideApproval(id, allow, always = false) {
  const key = String(id);
  if (S.approvalBusy.has(key)) return;
  S.approvalBusy.add(key);
  for (const card of document.querySelectorAll('.approval-card')) {
    if (card.dataset.approvalId === key) card.classList.add('is-busy');
  }
  try {
    const body = { allow: Boolean(allow) };
    if (always) body.always = true;
    if (!allow) body.message = 'The user denied this action.';
    await api(`${API}/approvals/${enc(key)}`, { method: 'POST', body });
    markApprovalResolved(key, allow ? 'approved' : 'denied');
    if (always) toast('Got it — I won’t ask again for this tool in this conversation.', { kind: 'success' });
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 410) {
      markApprovalResolved(key, 'expired');
      toast('That request is no longer waiting (it may have timed out).', { kind: 'warn' });
    } else {
      toast(`Couldn't send your decision: ${e.message}`, { kind: 'error' });
      for (const card of document.querySelectorAll('.approval-card')) {
        if (card.dataset.approvalId === key) card.classList.remove('is-busy');
      }
    }
  } finally {
    S.approvalBusy.delete(key);
  }
}

function applyApprovalOutcome(card, outcome) {
  card.classList.remove('is-busy');
  card.classList.add('is-resolved', `is-${outcome}`);
  const label = { approved: 'Approved — continuing', denied: 'Denied', expired: 'No longer waiting (timed out)' }[outcome] || 'Resolved';
  const state = card.querySelector('.ap-state');
  if (state) {
    state.hidden = false;
    state.replaceChildren(icon(outcome === 'approved' ? 'check' : 'x', 14), h('span', { text: label }));
  }
  for (const b of card.querySelectorAll('.ap-actions button')) b.disabled = true;
  const countdown = card.querySelector('[data-countdown]');
  if (countdown) countdown.remove();
}

function approvalCard(a, { compact = false } = {}) {
  const d = describeTool(a.toolName, a.input);
  const summary = a.summary || d.label;
  const preview = inputPreview(a.toolName, a.input);
  const expiresAt = (toMs(a.createdAt) || Date.now()) + APPROVAL_TIMEOUT_MS;
  const card = h(
    'div',
    { class: `approval-card${compact ? ' is-compact' : ''}`, role: 'group', 'aria-label': `Approval needed: ${summary}`, dataset: { approvalId: a.id } },
    h(
      'div',
      { class: 'ap-head' },
      h('span', { class: 'ap-shield' }, icon('shield', 15)),
      h('span', { class: 'ap-title', text: 'Approval needed' }),
      h('span', { class: 'ap-tool', title: String(a.toolName || '') }, h('span', { class: 'ap-tool-ico', text: d.icon }), h('span', { text: d.pretty })),
    ),
    h('div', { class: 'ap-summary', text: summary }),
    compact && a.runId && S.runs.get(String(a.runId))?.title ? h('div', { class: 'ap-for', text: `Task: ${truncate(S.runs.get(String(a.runId)).title, 70)}` }) : null,
    preview && preview !== '{}' ? h('details', { class: 'ap-details', open: !compact && preview.length < 240 ? true : null }, h('summary', { text: 'Details' }), h('pre', { class: 'ap-pre', text: preview })) : null,
    h(
      'div',
      { class: 'ap-actions' },
      btn('Approve', { cls: 'btn btn-approve', icon: 'check', onClick: () => decideApproval(a.id, true) }),
      btn('Deny', { cls: 'btn btn-deny', icon: 'x', onClick: () => decideApproval(a.id, false) }),
      btn('Always allow', { cls: 'btn btn-ghost btn-always', title: `Always allow ${d.pretty} in this conversation`, onClick: () => decideApproval(a.id, true, true) }),
    ),
    h('div', { class: 'ap-foot' }, h('span', { class: 'ap-countdown', dataset: { countdown: String(expiresAt) } }), compact && a.conversationId ? btn('Open chat', { cls: 'btn-link', onClick: () => openConversation(String(a.conversationId), { followRunId: a.runId }) }) : null),
    h('div', { class: 'ap-state', hidden: true }),
  );
  const outcome = S.resolved.get(a.id);
  if (outcome) applyApprovalOutcome(card, outcome);
  else if (S.approvalBusy.has(a.id)) card.classList.add('is-busy');
  return card;
}

/* ======================================================= alerts (banners) */

function pushAlert(alert) {
  S.reminders = S.reminders.filter((r) => r.key !== alert.key);
  S.reminders.unshift(alert);
  if (S.reminders.length > 4) S.reminders.length = 4;
  renderAlerts();
}

function dismissAlert(key) {
  S.reminders = S.reminders.filter((r) => r.key !== key);
  renderAlerts();
}

async function snoozeReminder(alert, minutes = 10) {
  const when = new Date(Date.now() + minutes * 60000);
  try {
    await api(`${API}/tasks`, { method: 'POST', body: { title: alert.title, when: when.toISOString(), kind: 'reminder', notes: alert.task?.notes || undefined } });
    dismissAlert(alert.key);
    toast(`Snoozed until ${formatClock(when.getTime())}`, { kind: 'success' });
    refreshTasks();
  } catch (e) {
    toast(`Couldn't snooze: ${e.message}`, { kind: 'error' });
  }
}

// The panel is only ~620 px tall: stacked banners must not bury the chat, so only the newest few are shown.
const MAX_VISIBLE_ALERTS = 2;

function renderAlerts() {
  const host = $('#alerts');
  if (!host) return;
  const nodes = [];
  const inlineRuns = new Set(S.tab === 'chat' ? [...S.runViews.keys()] : []);
  const floating = [...S.approvals.values()].filter((a) => !(a.runId && inlineRuns.has(String(a.runId))));
  for (const a of floating.slice(0, 3)) nodes.push(approvalCard(a, { compact: true }));
  if (floating.length > 3) nodes.push(h('div', { class: 'alert-more', text: `+${floating.length - 3} more waiting — see Activity` }));
  if (S.reminders.length <= MAX_VISIBLE_ALERTS) S.alertsExpanded = false;
  const visible = S.alertsExpanded ? S.reminders : S.reminders.slice(0, MAX_VISIBLE_ALERTS);
  const hidden = S.reminders.length - visible.length;
  for (const r of visible) {
    const isReminder = r.kind === 'reminder';
    nodes.push(
      h(
        'div',
        { class: `banner banner-${r.kind}`, role: 'alert' },
        h('span', { class: 'banner-ico' }, isReminder ? icon('bell', 18) : h('span', { text: r.kind === 'error' ? '⚠️' : '✨' })),
        h(
          'div',
          { class: 'banner-body' },
          h('div', { class: 'banner-kicker', text: isReminder ? `Reminder · ${formatClock(r.at)}` : r.kicker || 'Scheduled task finished' }),
          h('div', { class: 'banner-title', text: r.title }),
          r.message ? h('div', { class: 'banner-msg', text: truncate(r.message, 220) }) : null,
          h(
            'div',
            { class: 'banner-actions' },
            isReminder ? btn('Done', { cls: 'btn btn-small btn-primary', icon: 'check', onClick: () => dismissAlert(r.key) }) : null,
            isReminder ? btn('Snooze 10 min', { cls: 'btn btn-small', icon: 'snooze', onClick: () => snoozeReminder(r) }) : null,
            !isReminder && r.conversationId ? btn('Open', { cls: 'btn btn-small', onClick: () => { dismissAlert(r.key); openConversation(r.conversationId); } }) : null,
          ),
        ),
        iconBtn('x', 'Dismiss', () => dismissAlert(r.key), 'banner-close'),
      ),
    );
  }
  if (hidden > 0 || (S.alertsExpanded && S.reminders.length > MAX_VISIBLE_ALERTS)) {
    nodes.push(
      h(
        'div',
        { class: 'alert-more alert-more-row' },
        btn(hidden > 0 ? `Show ${hidden} more alert${hidden === 1 ? '' : 's'}` : 'Show fewer', {
          cls: 'btn btn-small btn-ghost',
          onClick: () => { S.alertsExpanded = !S.alertsExpanded; renderAlerts(); },
        }),
        btn('Dismiss all', { cls: 'btn btn-small btn-ghost', onClick: () => { S.reminders = []; renderAlerts(); } }),
      ),
    );
  }
  // Banners shrink the thread: keep it pinned to the latest message if it was at the bottom.
  withAutoScroll(() => {
    host.replaceChildren(...nodes);
    host.classList.toggle('has-items', nodes.length > 0);
  });
}

/* =================================================================== chat */

const thread = () => $('#thread');

function nearBottom() {
  const t = thread();
  return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 90;
}

function scrollToBottom(force = false) {
  const t = thread();
  if (t && (force || nearBottom())) t.scrollTop = t.scrollHeight;
}

function withAutoScroll(fn) {
  const stick = nearBottom();
  fn();
  if (stick) scrollToBottom(true);
}

function showWelcome(on) {
  const w = $('#welcome');
  if (w) w.hidden = !on;
}

function clearThread() {
  const t = thread();
  if (!t) return;
  for (const el of [...t.children]) if (el.id !== 'welcome') el.remove();
}

function avatar() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  for (const [i, [cx, cy, rx, ry]] of [[16, 26.5, 12.5, 4], [15.5, 19.8, 9.5, 3.5], [16.5, 13.6, 6.8, 3], [15.8, 8.2, 4.4, 2.5]].entries()) {
    const e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('cx', String(cx));
    e.setAttribute('cy', String(cy));
    e.setAttribute('rx', String(rx));
    e.setAttribute('ry', String(ry));
    e.setAttribute('class', `stone s${i + 1}`);
    svg.append(e);
  }
  return h('div', { class: 'avatar', 'aria-hidden': 'true' }, svg);
}

function typingDots() {
  return h('div', { class: 'typing', role: 'img', 'aria-label': 'Cairn is working' }, h('span'), h('span'), h('span'));
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Copied', { kind: 'success', timeout: 1500 });
      return;
    }
  } catch {
    // Fall back to the server-side clipboard (pbcopy) below.
  }
  try {
    await api(`${API}/clipboard`, { method: 'POST', body: { op: 'write', text } });
    toast('Copied', { kind: 'success', timeout: 1500 });
  } catch (e) {
    toast(`Couldn't copy: ${e.message}`, { kind: 'error' });
  }
}

function stepChip(step) {
  const d = describeTool(step.name, step.input);
  const status = step.status || 'running';
  return h(
    'span',
    { class: `step step-${status}`, title: [d.label, step.summary ? `→ ${truncate(step.summary, 200)}` : ''].filter(Boolean).join('\n') },
    h('span', { class: 'step-ico', text: d.icon }),
    h('span', { class: 'step-label', text: d.label }),
    status === 'ok' ? h('span', { class: 'step-state' }, icon('check', 12)) : status === 'error' ? h('span', { class: 'step-state' }, icon('x', 12)) : h('span', { class: 'step-pulse', 'aria-hidden': 'true' }),
  );
}

// Claude CLI plumbing (loading deferred tool schemas, todo bookkeeping) — not a step the user cares about.
const HIDDEN_STEP_TOOLS = new Set(['ToolSearch', 'TodoWrite']);

function renderSteps(container, allSteps, expanded, onToggle) {
  const MAX = 5;
  const steps = allSteps.filter((s) => !HIDDEN_STEP_TOOLS.has(String(s?.name || '')));
  const list = steps.length > MAX + 1 && !expanded ? steps.slice(-MAX) : steps;
  const nodes = [];
  if (list.length < steps.length) nodes.push(btn(`+${steps.length - list.length} earlier steps`, { cls: 'step step-more', onClick: onToggle }));
  for (const s of list) nodes.push(stepChip(s));
  if (expanded && steps.length > MAX + 1) nodes.push(btn('Show less', { cls: 'step step-more', onClick: onToggle }));
  container.replaceChildren(...nodes);
  container.hidden = nodes.length === 0;
}

function messageMeta(parts, copyTextValue) {
  const meta = h('div', { class: 'msg-meta' });
  for (const p of parts.filter(Boolean)) meta.append(h('span', { text: p }));
  if (copyTextValue) meta.append(iconBtn('copy', 'Copy message', () => copyText(copyTextValue), 'meta-btn'));
  return meta;
}

function renderUserMessage(msg) {
  const ts = toMs(msg.ts);
  return h(
    'article',
    { class: 'msg msg-user' },
    h('div', { class: 'msg-col' }, h('div', { class: 'bubble', text: msg.text ?? '' }), messageMeta([ts ? formatClock(ts) : ''])),
  );
}

function renderStoredAssistant(msg) {
  const ts = toMs(msg.ts);
  // Stored steps hold a `tool` entry and a matching `tool_result` entry per call: merge them into one chip.
  const steps = [];
  const byId = new Map();
  for (const e of Array.isArray(msg.events) ? msg.events : []) {
    if (!e || typeof e !== 'object' || !e.name) continue;
    if (e.type === undefined || e.type === 'tool') {
      const step = { id: e.id ?? null, name: e.name, input: e.input, status: e.isError ? 'error' : 'ok', summary: e.summary };
      steps.push(step);
      if (e.id) byId.set(String(e.id), step);
    } else if (e.type === 'tool_result') {
      const step = e.id ? byId.get(String(e.id)) : null;
      if (step) {
        step.status = e.isError ? 'error' : 'ok';
        if (e.summary) step.summary = e.summary;
      } else steps.push({ id: e.id ?? null, name: e.name, input: e.input, status: e.isError ? 'error' : 'ok', summary: e.summary });
    }
  }
  const stepsEl = h('div', { class: 'steps' });
  let expanded = false;
  const draw = () => renderSteps(stepsEl, steps, expanded, () => { expanded = !expanded; draw(); });
  draw();
  const body = h('div', { class: 'md' });
  body.innerHTML = renderMarkdown(msg.text || ''); // escaped by renderMarkdown
  return h(
    'article',
    { class: `msg msg-assistant${msg.error ? ' is-error' : ''}` },
    avatar(),
    h('div', { class: 'msg-col' }, stepsEl, msg.text ? h('div', { class: 'bubble' }, body) : null, messageMeta([ts ? formatClock(ts) : '', formatCost(msg.costUsd)], msg.text || '')),
  );
}

function renderSystemMessage(msg) {
  return h('div', { class: 'msg-system', role: 'note' }, h('span', { text: truncate(msg.text || '', 400) }));
}

function renderMessages(messages) {
  const t = thread();
  if (!t) return;
  clearThread();
  const frag = document.createDocumentFragment();
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'user') frag.append(renderUserMessage(m));
    else if (m.role === 'assistant') frag.append(renderStoredAssistant(m));
    else frag.append(renderSystemMessage(m));
  }
  t.append(frag);
  showWelcome(messages.length === 0);
}

/** Live view of one background run, fed by /api/assistant/runs/:id/events. */
class RunView {
  constructor(runId, conversationId, { startedAt } = {}) {
    this.runId = String(runId);
    this.conversationId = conversationId ? String(conversationId) : null;
    this.startedAt = startedAt || S.runs.get(this.runId)?.startedAt || Date.now();
    this.es = null;
    this.opens = 0;
    this.errors = 0;
    this.finished = false;
    this.cancelRequested = false;
    this.lost = false;
    this.expanded = false;
    this._raf = 0;
    this.lastSeq = null; // numeric SSE id of the last event applied
    this.sawIds = false;
    this.resetState();
    this.stepsEl = h('div', { class: 'steps', hidden: true });
    this.bodyEl = h('div', { class: 'md' });
    this.typingEl = typingDots();
    this.bubbleEl = h('div', { class: 'bubble' }, this.bodyEl, this.typingEl);
    this.approvalsEl = h('div', { class: 'inline-approvals' });
    this.noteEl = h('div', { class: 'live-note', hidden: true });
    this.metaEl = h('div', { class: 'msg-meta' });
    this.el = h('article', { class: 'msg msg-assistant is-live', dataset: { runId: this.runId } }, avatar(), h('div', { class: 'msg-col' }, this.stepsEl, this.bubbleEl, this.approvalsEl, this.noteEl, this.metaEl));
    this.render();
  }

  resetState() {
    this.segments = [];
    this.steps = [];
    this.approvalIds = [];
    this.status = '';
    this.result = null;
    this.error = null;
  }

  connect() {
    if (this.es || this.finished || typeof EventSource !== 'function') return;
    const es = new EventSource(`${API}/runs/${enc(this.runId)}/events`);
    this.es = es;
    es.addEventListener('open', () => {
      this.opens++;
      this.errors = 0;
      if (this.opens > 1 && !this.sawIds) {
        // Without SSE ids the server replays the run from the start on every
        // reconnect; with ids the browser sends Last-Event-ID and it resumes.
        this.resetState();
        this.scheduleRender();
      }
    });
    for (const type of RUN_EVENT_TYPES) {
      if (type === 'error') continue;
      es.addEventListener(type, (ev) => this.onMessage(type, ev.data, ev.lastEventId));
    }
    es.addEventListener('message', (ev) => this.onMessage(null, ev.data, ev.lastEventId));
    es.addEventListener('error', (ev) => {
      // A named "error" SSE event carries data; a bare Event is a connection problem.
      if (typeof ev.data === 'string' && ev.data) {
        this.onMessage('error', ev.data, ev.lastEventId);
        return;
      }
      this.errors++;
      if (es.readyState === 2 || this.errors > 8) {
        es.close();
        if (this.es === es) this.es = null;
        this.onStreamLost();
      }
    });
  }

  close() {
    if (this.es) this.es.close();
    this.es = null;
  }

  dispose() {
    this.close();
    clearTimeout(this._rafFallback);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  onStreamLost() {
    if (this.finished) return;
    this.lost = true;
    this.scheduleRender();
    refreshRuns();
  }

  onMessage(type, data, eventId) {
    if (eventId !== undefined && eventId !== null && eventId !== '') {
      const n = Number(eventId);
      if (Number.isFinite(n)) {
        // Never apply the same event twice (e.g. a replay after reconnect).
        if (this.lastSeq !== null && n <= this.lastSeq && type !== 'done') return;
        this.lastSeq = n;
        this.sawIds = true;
      }
    }
    let ev;
    try {
      ev = typeof data === 'string' && data ? JSON.parse(data) : {};
    } catch {
      ev = { message: String(data) };
    }
    if (!ev || typeof ev !== 'object') ev = { value: ev };
    const t = ev.type || type;
    this.lost = false;
    switch (t) {
      case 'status':
        if (ev.message) this.status = String(ev.message);
        break;
      case 'text':
        if (ev.text) this.segments.push(String(ev.text));
        break;
      case 'tool':
        this.steps.push({ id: ev.id ?? ev.toolUseId ?? null, name: ev.name, input: ev.input, status: 'running' });
        break;
      case 'tool_result': {
        const id = ev.id ?? ev.toolUseId ?? null;
        let step = id ? this.steps.find((s) => s.id === id) : null;
        if (!step && ev.name) step = [...this.steps].reverse().find((s) => s.name === ev.name && s.status === 'running');
        if (!step) step = [...this.steps].reverse().find((s) => s.status === 'running');
        if (step) {
          step.status = ev.isError ? 'error' : 'ok';
          step.summary = ev.summary ?? ev.text ?? '';
          const tool = splitToolName(step.name).tool;
          if (/task/.test(tool) && S.booted) refreshTasks();
          if (/shopping/.test(tool) && S.booted) refreshShopping();
        }
        break;
      }
      case 'approval': {
        const a = normalizeApproval(ev.approval || ev);
        if (!a) break;
        if (!a.runId) a.runId = this.runId;
        if (!this.approvalIds.includes(a.id)) this.approvalIds.push(a.id);
        if (S.resolved.has(a.id)) cacheApproval({ ...(S.approvalCache.get(a.id) || {}), ...a });
        else upsertApproval(a, { notify: true });
        break;
      }
      case 'approval_resolved': {
        const id = ev.id ?? ev.approval?.id;
        if (id !== undefined) {
          const allow = ev.allow ?? ev.decision?.allow;
          if (!this.approvalIds.includes(String(id))) this.approvalIds.push(String(id));
          if (!S.resolved.has(String(id)) || S.approvals.has(String(id))) markApprovalResolved(id, allow ? 'approved' : allow === false ? 'denied' : 'expired');
        }
        break;
      }
      case 'result':
        this.result = ev;
        if (ev.text) {
          // result.text is either the last streamed block or all blocks joined — never render it twice.
          const rt = String(ev.text).trim();
          const last = (this.segments[this.segments.length - 1] || '').trim();
          const joined = this.segments.map((x) => String(x).trim()).filter(Boolean).join('\n\n');
          if (!this.segments.length) this.segments.push(String(ev.text));
          else if (rt === last || rt === joined || joined.endsWith(rt)) {
            // already shown
          } else if (rt.startsWith(joined) || (last && rt.includes(last))) this.segments = [String(ev.text)];
          else this.segments.push(String(ev.text));
        }
        if (ev.isError && !ev.text) this.error = ev.error || 'The run ended with an error';
        break;
      case 'error':
        this.error = ev.message || ev.error || 'Something went wrong';
        break;
      case 'done':
        this.finish(ev);
        break;
      case 'state':
      case 'queued':
      case 'started': {
        const run = S.runs.get(this.runId);
        if (run && ev.state) {
          run.state = ev.state;
          scheduleActivityRender();
        }
        break;
      }
      default:
        break;
    }
    this.scheduleRender();
    updateRunBar();
  }

  finish(ev = {}) {
    if (this.finished) return;
    this.finished = true;
    this.close();
    const run = S.runs.get(this.runId) || { runId: this.runId, conversationId: this.conversationId, startedAt: this.startedAt };
    run.state = ev.state || (this.cancelRequested ? 'cancelled' : this.error ? 'error' : 'done');
    run.finishedAt = run.finishedAt || Date.now();
    if (this.result?.costUsd !== undefined) run.costUsd = this.result.costUsd;
    S.runs.set(this.runId, run);
    for (const s of this.steps) if (s.status === 'running') s.status = 'ok';
    notifyRunDone(run);
    if (this._stick === undefined) this._stick = nearBottom();
    this.flush();
    updateRunBar();
    scheduleActivityRender();
    renderBadges();
    renderHealth();
  }

  scheduleRender() {
    if (this._raf) return;
    // Decide stickiness before this batch of events changes the layout.
    this._stick = nearBottom();
    if (typeof requestAnimationFrame !== 'function') {
      this.flush();
      return;
    }
    this._raf = requestAnimationFrame(() => this.flush());
    // rAF is paused while the page is occluded/hidden (closed panel, background window): never let the
    // transcript fall behind the stream — flush on a timer if no frame arrives.
    clearTimeout(this._rafFallback);
    this._rafFallback = setTimeout(() => {
      if (this._raf) this.flush();
    }, 250);
  }

  flush() {
    const stick = this._raf || this._stick !== undefined ? this._stick : nearBottom();
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._rafFallback);
    this._raf = 0;
    this._stick = undefined;
    this.render();
    if (stick) scrollToBottom(true);
  }

  pendingApprovals() {
    return this.approvalIds.filter((id) => S.approvals.has(id));
  }

  activityText() {
    const run = S.runs.get(this.runId);
    if (this.pendingApprovals().length) return 'Waiting for your approval';
    if (run?.state === 'queued') return 'Queued — starts when a slot frees up';
    const running = [...this.steps].reverse().find((s) => s.status === 'running' && !HIDDEN_STEP_TOOLS.has(String(s.name || '')));
    if (running) return `${describeTool(running.name, running.input).label}…`;
    if (this.segments.length) return 'Writing…';
    return this.status ? truncate(this.status, 60) : 'Thinking…';
  }

  render() {
    renderSteps(this.stepsEl, this.steps, this.expanded, () => {
      this.expanded = !this.expanded;
      this.render();
    });
    const text = this.segments.join('\n\n');
    this.bodyEl.innerHTML = renderMarkdown(text); // escaped by renderMarkdown
    this.bodyEl.hidden = !text;
    this.typingEl.hidden = this.finished;
    this.bubbleEl.hidden = this.finished && !text;
    this.el.classList.toggle('is-live', !this.finished);
    this.el.classList.toggle('is-error', Boolean(this.error));

    const cards = [];
    for (const id of this.approvalIds) {
      if (!S.approvals.has(id) && !S.resolved.has(id)) continue;
      const a = S.approvals.get(id) || S.approvalCache.get(id) || { id, toolName: '', summary: 'Approval request' };
      cards.push(approvalCard(a));
    }
    this.approvalsEl.replaceChildren(...cards);

    let note = '';
    let noteCls = 'live-note';
    if (this.error) {
      note = this.error;
      noteCls += ' is-error';
    } else if (this.finished && this.cancelRequested) {
      note = 'Stopped.';
    } else if (this.lost && !this.finished) {
      note = 'Lost the live stream — the task keeps running in the background. Check Activity.';
      noteCls += ' is-warn';
    } else if (!this.finished && !text && this.status && !this.steps.length) {
      note = this.status;
    }
    this.noteEl.className = noteCls;
    this.noteEl.textContent = note;
    this.noteEl.hidden = !note;

    const r = this.result || {};
    const parts = [];
    if (this.finished) {
      parts.push(formatClock(Date.now()));
      const dur = Number(r.durationMs) || (S.runs.get(this.runId)?.finishedAt || Date.now()) - this.startedAt;
      if (dur > 0) parts.push(formatDuration(dur));
      parts.push(formatCost(r.costUsd));
    }
    this.metaEl.replaceChildren(...messageMeta(parts, this.finished && text ? text : '').childNodes);
    this.metaEl.hidden = !this.finished;
  }
}

function liveRunView() {
  const views = [...S.runViews.values()].filter((v) => !v.finished);
  return views[views.length - 1] || null;
}

function activeRunsForConversation(id) {
  if (!id) return [];
  const fromViews = [...S.runViews.values()].filter((v) => !v.finished && v.conversationId === id).map((v) => v.runId);
  const fromRuns = activeRuns().filter((r) => r.conversationId === id).map((r) => r.runId);
  return [...new Set([...fromViews, ...fromRuns])];
}

function updateRunBar() {
  const bar = $('#run-bar');
  const stop = $('#btn-stop');
  const rv = liveRunView();
  if (bar) bar.hidden = !rv;
  if (stop) stop.hidden = !rv;
  if (!rv) return;
  const waiting = rv.pendingApprovals().length > 0;
  bar.classList.toggle('is-waiting', waiting);
  $('#run-bar-text').textContent = rv.activityText();
  $('#run-bar-time').textContent = formatDuration(Date.now() - rv.startedAt);
}

function closeRunViews() {
  for (const rv of S.runViews.values()) rv.dispose();
  S.runViews.clear();
  updateRunBar();
}

function attachRun(runId, conversationId, opts) {
  const key = String(runId);
  if (S.runViews.has(key)) return S.runViews.get(key);
  const rv = new RunView(key, conversationId, opts);
  S.runViews.set(key, rv);
  thread()?.append(rv.el);
  rv.connect();
  showWelcome(false);
  updateRunBar();
  renderAlerts();
  return rv;
}

function newChat({ focus = true } = {}) {
  S.viewToken++;
  closeRunViews();
  clearThread();
  showWelcome(true);
  setConversationId(null);
  renderAlerts();
  if (S.tab !== 'chat') showTab('chat');
  if (focus) $('#composer-input')?.focus();
}

async function openConversation(id, { followRunId = null } = {}) {
  if (!id) return;
  if (S.tab !== 'chat') showTab('chat');
  const token = ++S.viewToken;
  closeRunViews();
  clearThread();
  showWelcome(false);
  setConversationId(id);
  const loading = h('div', { class: 'thread-loading' }, typingDots());
  thread()?.append(loading);
  try {
    await refreshRuns();
    const d = await api(`${API}/conversations/${enc(id)}`);
    if (token !== S.viewToken) return;
    const conv = d.conversation || d;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    renderMessages(messages);
    const last = messages[messages.length - 1];
    const lastAssistantTs = last && last.role === 'assistant' ? toMs(last.ts) || 0 : 0;
    const follow = new Set(activeRunsForConversation(id));
    if (followRunId && isActiveState(S.runs.get(String(followRunId))?.state)) follow.add(String(followRunId));
    const ordered = [...follow].map((rid) => S.runs.get(rid) || { runId: rid, startedAt: 0 }).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const run of ordered) {
      // Finished between the two requests: the stored answer is already shown.
      if (lastAssistantTs && run.startedAt && lastAssistantTs >= run.startedAt) continue;
      attachRun(run.runId, id, { startedAt: run.startedAt });
    }
    showWelcome(messages.length === 0 && ordered.length === 0);
    scrollToBottom(true);
  } catch (e) {
    if (token !== S.viewToken) return;
    loading.remove();
    if (e.status === 404) {
      setConversationId(null);
      showWelcome(true);
      toast('That conversation no longer exists.', { kind: 'warn' });
    } else {
      thread()?.append(h('div', { class: 'msg-system is-error' }, h('span', { text: `Couldn't load this conversation: ${e.message}` }), btn('Retry', { cls: 'btn-link', onClick: () => openConversation(id, { followRunId }) })));
    }
  } finally {
    loading.remove();
    renderAlerts();
    renderHistory();
  }
}

async function startChat(text) {
  const message = String(text || '').trim();
  if (!message) return;
  if (S.tab !== 'chat') showTab('chat');
  // A conversation with a task still in flight keeps going in the background;
  // the new message becomes its own background task in a fresh conversation.
  const busy = activeRunsForConversation(S.conversationId).length > 0;
  if (busy) newChat({ focus: false });
  const token = S.viewToken;
  const conversationId = S.conversationId;
  showWelcome(false);
  const userEl = renderUserMessage({ text: message, ts: Date.now() });
  userEl.classList.add('is-pending');
  withAutoScroll(() => thread()?.append(userEl));
  scrollToBottom(true);
  try {
    let res;
    try {
      res = await api(`${API}/chat`, { method: 'POST', body: conversationId ? { message, conversationId } : { message } });
    } catch (e) {
      // The saved conversation may have been deleted elsewhere: start a fresh one.
      if (e.status === 404 && conversationId) {
        res = await api(`${API}/chat`, { method: 'POST', body: { message } });
      } else throw e;
    }
    const runId = res.runId ?? res.run?.runId ?? res.id;
    const convId = res.conversationId ?? res.run?.conversationId ?? conversationId;
    if (!runId) throw new Error('The server did not return a run id');
    S.myRuns.add(String(runId));
    const existing = S.runs.get(String(runId)) || {};
    S.runs.set(String(runId), { state: 'running', startedAt: Date.now(), ...existing, runId: String(runId), conversationId: convId ? String(convId) : null, title: existing.title || truncate(message, 60) });
    userEl.classList.remove('is-pending');
    if (token === S.viewToken) {
      if (convId) setConversationId(String(convId));
      attachRun(runId, convId);
      scrollToBottom(true);
    }
    toast(BG_TOAST, { kind: 'info', action: busy ? { label: 'Activity', fn: () => showTab('activity') } : null });
    scheduleActivityRender();
    renderBadges();
    renderHealth();
  } catch (e) {
    userEl.classList.remove('is-pending');
    userEl.classList.add('is-failed');
    userEl.querySelector('.msg-col')?.append(
      h('div', { class: 'msg-fail' }, h('span', { text: `Not sent: ${e.message}` }), btn('Retry', { cls: 'btn-link', onClick: () => { userEl.remove(); startChat(message); } })),
    );
    toast(`Couldn't start the task: ${e.message}`, { kind: 'error' });
  }
}

async function stopCurrentRun() {
  const rv = liveRunView();
  if (!rv) return;
  rv.cancelRequested = true;
  try {
    await api(`${API}/runs/${enc(rv.runId)}/cancel`, { method: 'POST', body: {} });
    toast('Stopping…', { kind: 'info', timeout: 2000 });
  } catch (e) {
    rv.cancelRequested = false;
    toast(`Couldn't stop: ${e.message}`, { kind: 'error' });
  }
}

function prefill(text, { focus = true } = {}) {
  const input = $('#composer-input');
  if (!input) return;
  if (S.tab !== 'chat') showTab('chat');
  input.value = text;
  autosize(input);
  if (focus) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

const QUICK_ACTIONS = [
  { icon: '⏰', label: 'Remind me…', text: 'Remind me to ' },
  { icon: '🔎', label: 'Search the web for…', text: 'Search the web for ' },
  { icon: '🛒', label: 'Shop for…', text: 'Shop for ' },
  { icon: '🗂️', label: 'Organize my Downloads…', text: 'Organize my Downloads folder by file type' },
];

const WELCOME_CARDS = [
  { icon: '⏰', title: 'Set a reminder', text: 'Remind me to call Mom tomorrow at 6pm' },
  { icon: '🔎', title: 'Research', text: 'Find the best budget espresso machine' },
  { icon: '🛒', title: 'Shop & compare', text: 'Shop for headphones under $200' },
  { icon: '🗓️', title: 'Every morning', text: 'Every weekday at 8am, brief me on the news' },
];

function setupComposer() {
  const form = $('#composer');
  const input = $('#composer-input');
  if (!form || !input) return;
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) {
      input.focus();
      return;
    }
    input.value = '';
    autosize(input);
    input.focus();
    startChat(text);
  });
  $('#btn-stop')?.addEventListener('click', stopCurrentRun);

  const chips = $('#quick-chips');
  chips?.replaceChildren(...QUICK_ACTIONS.map((q) => h('button', { type: 'button', class: 'qchip', onclick: () => prefill(q.text) }, h('span', { class: 'qchip-ico', text: q.icon }), h('span', { text: q.label }))));
  $('#welcome-grid')?.replaceChildren(
    ...WELCOME_CARDS.map((c) => h('button', { type: 'button', class: 'wcard', onclick: () => prefill(c.text) }, h('span', { class: 'wcard-ico', text: c.icon }), h('span', { class: 'wcard-title', text: c.title }), h('span', { class: 'wcard-text', text: c.text }))),
  );
}

/* =============================================================== activity */

let activityTimer = 0;
function scheduleActivityRender() {
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = 0;
    renderActivity();
    renderBadges();
  }, 40);
}

async function refreshRuns() {
  try {
    const d = await api(`${API}/runs`);
    const list = Array.isArray(d.runs) ? d.runs : Array.isArray(d) ? d : [];
    const seen = new Set();
    for (const raw of list) {
      const r = normalizeRun(raw);
      if (!r.runId) continue;
      seen.add(r.runId);
      mergeRun(r, { fromPoll: true });
    }
    // Drop runs the server no longer reports (keep very recent local ones and live views).
    for (const [id, r] of S.runs) {
      const live = S.runViews.get(id);
      if (!seen.has(id) && Date.now() - (r.startedAt || 0) > 15000 && !(live && !live.finished)) S.runs.delete(id);
    }
    scheduleActivityRender();
    renderHealth();
  } catch {
    // Offline or not wired yet; health reporting covers it.
  }
}

function mergeRun(r, { fromPoll = false } = {}) {
  if (!r.runId) return null;
  const prev = S.runs.get(r.runId);
  const wasActive = prev ? isActiveState(prev.state) : null;
  const next = { ...(prev || {}), ...r };
  if (!next.startedAt) next.startedAt = prev?.startedAt || Date.now();
  S.runs.set(r.runId, next);
  if (next.state && !isActiveState(next.state)) {
    if (!S.booted || (fromPoll && wasActive === null)) S.notifiedDone.add(r.runId);
    else if (wasActive !== false) notifyRunDone(next);
    const rv = S.runViews.get(r.runId);
    if (rv && !rv.finished && (rv.lost || !rv.es)) {
      // The live stream was lost: reload the conversation to show the final answer.
      if (rv.conversationId && rv.conversationId === S.conversationId) openConversation(rv.conversationId);
    }
  }
  return next;
}

function notifyRunDone(run) {
  if (S.notifiedDone.has(run.runId)) return;
  S.notifiedDone.add(run.runId);
  const inView = S.runViews.has(run.runId) && S.tab === 'chat' && !document.hidden;
  if (inView) return;
  if (S.tab !== 'activity') S.unseenDone++;
  const title = run.title || 'Background task';
  const kind = run.state === 'error' ? 'error' : run.state === 'cancelled' ? 'warn' : 'success';
  const verb = run.state === 'error' ? 'Failed' : run.state === 'cancelled' ? 'Cancelled' : 'Finished';
  toast(`${verb}: ${truncate(title, 60)}`, { kind, timeout: 7000, action: run.conversationId ? { label: 'Open', fn: () => openConversation(run.conversationId, { followRunId: run.runId }) } : null });
  renderBadges();
}

async function cancelRun(runId) {
  try {
    await api(`${API}/runs/${enc(runId)}/cancel`, { method: 'POST', body: {} });
    const rv = S.runViews.get(String(runId));
    if (rv) rv.cancelRequested = true;
    toast('Cancelling…', { kind: 'info', timeout: 2000 });
    setTimeout(refreshRuns, 800);
  } catch (e) {
    toast(`Couldn't cancel: ${e.message}`, { kind: 'error' });
  }
}

function stateChip(state) {
  const info = RUN_STATES[state] || { label: state || 'Unknown', cls: 's-queued' };
  return h('span', { class: `state-chip ${info.cls}` }, state === 'running' ? h('span', { class: 'mini-spinner', 'aria-hidden': 'true' }) : h('span', { class: 'state-dot', 'aria-hidden': 'true' }), h('span', { text: info.label }));
}

function renderActivity() {
  const host = $('#runs-list');
  if (!host) return;
  const runs = [...S.runs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const counts = { running: 0, queued: 0, waiting_approval: 0 };
  for (const r of runs) if (counts[r.state] !== undefined) counts[r.state]++;
  const summary = [
    counts.running ? `${counts.running} running` : '',
    counts.queued ? `${counts.queued} queued` : '',
    counts.waiting_approval ? `${counts.waiting_approval} need${counts.waiting_approval === 1 ? 's' : ''} approval` : '',
  ].filter(Boolean);
  const sum = $('#activity-summary');
  if (sum) sum.textContent = summary.length ? summary.join(' · ') : runs.length ? 'All caught up. Recent tasks below.' : 'Nothing running right now.';
  if (!runs.length) {
    host.replaceChildren(
      h('div', { class: 'empty' }, h('div', { class: 'empty-ico', text: '🪨' }), h('div', { class: 'empty-title', text: 'No background tasks yet' }), h('div', { class: 'empty-text', text: 'Anything you ask runs here in the background — close the panel and I’ll keep going.' }), btn('Start a task', { cls: 'btn btn-primary btn-small', onClick: () => showTab('chat') })),
    );
    return;
  }
  host.replaceChildren(
    ...runs.map((r) => {
      const active = isActiveState(r.state);
      const pending = [...S.approvals.values()].filter((a) => String(a.runId) === r.runId);
      const state = pending.length && active ? 'waiting_approval' : r.state;
      const open = () => (r.conversationId ? openConversation(r.conversationId, { followRunId: r.runId }) : toast('This run has no conversation to open.', { kind: 'warn' }));
      const elapsed = h('span', { class: 'elapsed', dataset: { since: r.startedAt || null, until: active ? null : r.finishedAt || null } });
      elapsed.textContent = r.startedAt ? formatDuration((active ? Date.now() : r.finishedAt || Date.now()) - r.startedAt) : '';
      return h(
        'div',
        { class: `row run-row${active ? ' is-active' : ''}${r.conversationId && r.conversationId === S.conversationId ? ' is-current' : ''}`, dataset: { runId: r.runId } },
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-top' }, stateChip(state), h('button', { type: 'button', class: 'row-title', title: r.title || '', onclick: open, text: r.title || 'Untitled task' })),
          h('div', { class: 'row-sub', text: pending.length ? `Waiting: ${pending[0].summary || describeTool(pending[0].toolName, pending[0].input).label}` : r.error && r.state === 'error' ? r.error : plainText(r.lastEvent) || (active ? 'Working…' : '') }),
          h(
            'div',
            { class: 'row-meta' },
            h('span', { class: 'meta-item' }, icon('clock', 12), elapsed),
            formatCost(r.costUsd) ? h('span', { class: 'meta-item', text: formatCost(r.costUsd) }) : null,
            r.startedAt ? h('span', { class: 'meta-item', text: timeAgo(r.startedAt) }) : null,
          ),
        ),
        h(
          'div',
          { class: 'row-actions' },
          pending.length ? btn('Review', { cls: 'btn btn-small btn-amber', onClick: open }) : iconBtn('open', 'Open conversation', open),
          active ? iconBtn('stop', 'Cancel this task', () => cancelRun(r.runId), 'danger') : null,
        ),
      );
    }),
  );
}

/* ================================================================== tasks */

async function refreshTasks() {
  try {
    const d = await api(`${API}/tasks`);
    S.tasks = Array.isArray(d.tasks) ? d.tasks : Array.isArray(d) ? d : [];
    renderTasks();
    renderBadges();
  } catch (e) {
    if (S.tab === 'tasks' && e.status !== 0) toast(`Couldn't load tasks: ${e.message}`, { kind: 'error' });
  }
}

function renderTasks() {
  const host = $('#tasks-list');
  if (!host) return;
  const now = Date.now();
  const tasks = [...S.tasks].map((t) => ({ ...t, _next: toMs(t.nextRunAt) }));
  const active = tasks.filter((t) => (t.status || 'active') === 'active').sort((a, b) => (a._next ?? Infinity) - (b._next ?? Infinity));
  const done = tasks.filter((t) => (t.status || 'active') !== 'active').sort((a, b) => (toMs(b.lastRunAt) || 0) - (toMs(a.lastRunAt) || 0)).slice(0, 10);
  const sum = $('#tasks-summary');
  if (sum) {
    const next = active.find((t) => t._next);
    sum.textContent = active.length ? `${active.length} scheduled${next ? ` · next: ${truncate(next.title, 28)} ${timeUntil(next._next, now)}` : ''}` : 'Nothing scheduled yet.';
  }
  const row = (t) => {
    const isAgent = t.kind === 'agent';
    const last = Array.isArray(t.runs) && t.runs.length ? t.runs[t.runs.length - 1] : null;
    const rec = recurrenceLabel(t.recurrence);
    const inactive = (t.status || 'active') !== 'active';
    return h(
      'div',
      { class: `row task-row${inactive ? ' is-inactive' : ''}`, dataset: { taskId: t.id } },
      h('span', { class: `row-ico ${isAgent ? 'ico-agent' : 'ico-reminder'}`, text: isAgent ? '🤖' : '⏰', title: isAgent ? 'Agent task' : 'Reminder' }),
      h(
        'div',
        { class: 'row-main' },
        h('div', { class: 'row-title-static', text: t.title || t.prompt || 'Untitled' }),
        h(
          'div',
          { class: 'row-meta' },
          inactive ? h('span', { class: `pill pill-${t.status}`, text: t.status === 'cancelled' ? 'Cancelled' : 'Done' }) : t._next ? h('span', { class: `meta-item when${t._next < now ? ' is-overdue' : ''}`, text: `${formatWhen(t._next, now)} · ${timeUntil(t._next, now)}` }) : null,
          rec ? h('span', { class: 'meta-item rec', text: `↻ ${rec}` }) : null,
        ),
        isAgent && t.prompt && t.prompt !== t.title ? h('div', { class: 'row-sub', text: truncate(t.prompt, 120) }) : t.notes ? h('div', { class: 'row-sub', text: truncate(t.notes, 120) }) : null,
        last ? h('div', { class: `row-sub last-run ${last.ok === false ? 'is-error' : ''}`, text: `${last.ok === false ? '✗' : '✓'} Last run ${timeAgo(toMs(last.at), now)}${last.summary ? ` — ${truncate(plainText(last.summary), 90)}` : ''}` }) : null,
      ),
      inactive
        ? null
        : h('div', { class: 'row-actions' }, iconBtn('play', isAgent ? 'Run now' : 'Trigger now', () => runTaskNow(t)), iconBtn('trash', 'Cancel', () => cancelTask(t), 'danger')),
    );
  };
  const nodes = [];
  if (!active.length) {
    nodes.push(h('div', { class: 'empty' }, h('div', { class: 'empty-ico', text: '⏰' }), h('div', { class: 'empty-title', text: 'No reminders yet' }), h('div', { class: 'empty-text', text: 'Type something like “pay rent on the 1st at 9am” above, or ask in Chat.' })));
  } else nodes.push(...active.map(row));
  if (done.length) nodes.push(h('div', { class: 'list-section', text: 'Recently completed' }), ...done.map(row));
  host.replaceChildren(...nodes);
}

async function runTaskNow(t) {
  try {
    await api(`${API}/tasks/${enc(t.id)}/run`, { method: 'POST', body: {} });
    toast(t.kind === 'agent' ? BG_TOAST : `Triggered “${truncate(t.title, 40)}”`, { kind: 'info' });
    setTimeout(refreshTasks, 800);
    setTimeout(refreshRuns, 800);
  } catch (e) {
    toast(`Couldn't run it: ${e.message}`, { kind: 'error' });
  }
}

async function cancelTask(t) {
  try {
    await api(`${API}/tasks/${enc(t.id)}`, { method: 'DELETE', body: {} });
    S.tasks = S.tasks.filter((x) => x.id !== t.id);
    renderTasks();
    renderBadges();
    toast(`Cancelled “${truncate(t.title, 40)}”`, { kind: 'success' });
    refreshTasks();
  } catch (e) {
    toast(`Couldn't cancel: ${e.message}`, { kind: 'error' });
  }
}

function normalizeParse(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.when) return d;
  for (const k of ['result', 'parsed', 'task']) if (d[k] && typeof d[k] === 'object' && d[k].when) return d[k];
  return null;
}

function taskKind() {
  return document.querySelector('input[name="task-kind"]:checked')?.value === 'agent' ? 'agent' : 'reminder';
}

function setupTasks() {
  const form = $('#task-form');
  const input = $('#task-input');
  const preview = $('#task-preview');
  if (!form || !input || !preview) return;
  let parsed = null;
  let parseTimer = 0;
  let seq = 0;
  const showPreview = () => {
    const text = input.value.trim();
    if (!text) {
      preview.replaceChildren();
      preview.className = 'parse-preview';
      return;
    }
    if (!parsed) {
      preview.className = 'parse-preview is-unknown';
      preview.replaceChildren(h('span', { text: 'Add a time, like “tomorrow at 9am” or “every Monday”.' }));
      return;
    }
    const when = toMs(parsed.when);
    const rec = recurrenceLabel(parsed.recurrence);
    preview.className = 'parse-preview is-ok';
    setKids(
      preview,
      h('span', { class: 'pp-ico', text: taskKind() === 'agent' ? '🤖' : '⏰' }),
      h('span', { class: 'pp-title', text: parsed.title || text }),
      when ? h('span', { class: 'pp-when', text: `${formatWhen(when)} · ${timeUntil(when)}` }) : null,
      rec ? h('span', { class: 'pp-rec', text: `↻ ${rec}` }) : null,
    );
  };
  const parse = async () => {
    const text = input.value.trim();
    const my = ++seq;
    if (!text) {
      parsed = null;
      showPreview();
      return;
    }
    try {
      const d = await api(`${API}/tasks/parse`, { method: 'POST', body: { text } });
      if (my !== seq) return;
      parsed = normalizeParse(d);
    } catch {
      if (my !== seq) return;
      parsed = null;
    }
    showPreview();
  };
  input.addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(parse, 300);
  });
  for (const r of document.querySelectorAll('input[name="task-kind"]')) {
    r.addEventListener('change', () => {
      input.placeholder = taskKind() === 'agent' ? 'e.g. Every morning at 8, summarize tech news' : 'e.g. Stretch every weekday at 3pm';
      showPreview();
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const kind = taskKind();
    clearTimeout(parseTimer);
    const body = { text, kind };
    if (kind === 'agent') body.prompt = parsed?.title || text;
    const submitBtn = $('#btn-add-task');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const d = await api(`${API}/tasks`, { method: 'POST', body });
      const task = d.task || d;
      input.value = '';
      parsed = null;
      showPreview();
      const when = toMs(task.nextRunAt);
      toast(`${kind === 'agent' ? 'Scheduled' : 'Reminder set'}: ${truncate(task.title || text, 40)}${when ? ` · ${formatWhen(when)}` : ''}`, { kind: 'success' });
      refreshTasks();
      refreshHealth();
    } catch (err) {
      toast(`I couldn't work out when: ${err.message}`, { kind: 'error', timeout: 7000, action: { label: 'Ask in Chat', fn: () => prefill(/^remind/i.test(text) ? text : `${kind === 'agent' ? 'Schedule this: ' : 'Remind me to '}${text}`) } });
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

/* =============================================================== shopping */

async function refreshShopping() {
  try {
    const d = await api(`${API}/shopping`);
    S.shopping = Array.isArray(d.items) ? d.items : Array.isArray(d) ? d : [];
    renderShopping();
    renderBadges();
  } catch (e) {
    if (S.tab === 'shopping' && e.status !== 0) toast(`Couldn't load the shopping list: ${e.message}`, { kind: 'error' });
  }
}

export function parsePrice(p) {
  if (p === null || p === undefined || p === '') return null;
  if (typeof p === 'number') return Number.isFinite(p) ? p : null;
  const m = String(p).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function formatPrice(p) {
  if (p === null || p === undefined || p === '') return '';
  if (typeof p === 'number') return `$${p.toFixed(2)}`;
  const s = String(p).trim();
  return /^\d+(\.\d+)?$/.test(s) ? `$${Number(s).toFixed(2)}` : s;
}

function openExternal(url) {
  const href = safeUrl(url);
  if (!href) return;
  if (isNative()) {
    // WKWebView ignores target=_blank; ask the server to open the default browser.
    api(`${API}/open`, { method: 'POST', body: { url: href } }).catch((e) => toast(`Couldn't open the link: ${e.message}`, { kind: 'error' }));
  } else {
    window.open(href, '_blank', 'noopener');
  }
}

function renderShopping() {
  const host = $('#shopping-list');
  if (!host) return;
  const items = S.shopping;
  const prices = items.map((i) => parsePrice(i.price)).filter((n) => n !== null);
  const sum = $('#shopping-summary');
  if (sum) {
    sum.textContent = items.length
      ? `${items.length} item${items.length === 1 ? '' : 's'}${prices.length ? ` · est. $${prices.reduce((a, b) => a + b, 0).toFixed(2)}` : ''} · you always check out yourself`
      : 'Cairn researches and compares; you always check out yourself.';
  }
  if (!items.length) {
    host.replaceChildren(
      h('div', { class: 'empty' }, h('div', { class: 'empty-ico', text: '🛒' }), h('div', { class: 'empty-title', text: 'Your list is empty' }), h('div', { class: 'empty-text', text: 'Ask me to “shop for a standing desk under $300” and I’ll compare stores and save the best picks here.' }), btn('Shop for…', { cls: 'btn btn-primary btn-small', onClick: () => prefill('Shop for ') })),
    );
    return;
  }
  host.replaceChildren(
    ...items.map((it) => {
      const href = safeUrl(it.url);
      const name = it.item || it.title || it.name || 'Item';
      const title = href
        ? h('a', { class: 'row-title', href, target: '_blank', rel: 'noopener noreferrer', title: href, text: name, onclick: (e) => { if (isNative()) { e.preventDefault(); openExternal(href); } } })
        : h('div', { class: 'row-title-static', text: name });
      return h(
        'div',
        { class: 'row shop-row', dataset: { itemId: it.id } },
        h('span', { class: 'row-ico', text: '🛍️' }),
        h(
          'div',
          { class: 'row-main' },
          h('div', { class: 'row-top' }, title, it.price !== undefined && it.price !== null && it.price !== '' ? h('span', { class: 'price', text: formatPrice(it.price) }) : null),
          h('div', { class: 'row-meta' }, it.store ? h('span', { class: 'meta-item', text: it.store }) : null, href ? h('span', { class: 'meta-item', text: hostOf(href) }) : null, it.addedAt || it.createdAt ? h('span', { class: 'meta-item', text: timeAgo(toMs(it.addedAt || it.createdAt)) }) : null),
          it.notes ? h('div', { class: 'row-sub', text: truncate(it.notes, 140) }) : null,
        ),
        h(
          'div',
          { class: 'row-actions' },
          iconBtn('sparkle', 'Find a better price', () => prefill(`Find the best current price for "${name}"${it.store ? ` (currently ${formatPrice(it.price) || 'listed'} at ${it.store})` : ''} and compare a few stores.`)),
          iconBtn('trash', 'Remove', () => removeShoppingItem(it), 'danger'),
        ),
      );
    }),
  );
}

async function removeShoppingItem(it) {
  try {
    await api(`${API}/shopping/${enc(it.id)}`, { method: 'DELETE', body: {} });
    S.shopping = S.shopping.filter((x) => x.id !== it.id);
    renderShopping();
    renderBadges();
  } catch (e) {
    toast(`Couldn't remove it: ${e.message}`, { kind: 'error' });
  }
}

function setupShopping() {
  const form = $('#shop-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const itemEl = $('#shop-item');
    const priceEl = $('#shop-price');
    const item = itemEl.value.trim();
    if (!item) return;
    const body = { item };
    const maybeUrl = item.match(/https?:\/\/\S+/);
    if (maybeUrl && safeUrl(maybeUrl[0])) {
      body.url = safeUrl(maybeUrl[0]);
      body.item = item.replace(maybeUrl[0], '').trim() || hostOf(body.url);
    }
    if (priceEl.value.trim()) body.price = priceEl.value.trim();
    try {
      await api(`${API}/shopping`, { method: 'POST', body });
      itemEl.value = '';
      priceEl.value = '';
      refreshShopping();
    } catch (err) {
      toast(`Couldn't add it: ${err.message}`, { kind: 'error' });
    }
  });
}

/* ================================================================ history */

async function refreshHistory() {
  try {
    const d = await api(`${API}/conversations`);
    S.conversations = Array.isArray(d.conversations) ? d.conversations : Array.isArray(d) ? d : [];
    renderHistory();
    return true;
  } catch (e) {
    if (S.tab === 'history' && e.status !== 0) toast(`Couldn't load conversations: ${e.message}`, { kind: 'error' });
    return false;
  }
}

const pendingDelete = new Set();

function renderHistory() {
  const host = $('#history-list');
  if (!host) return;
  const q = ($('#history-filter')?.value || '').trim().toLowerCase();
  const list = S.conversations.filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  const sum = $('#history-summary');
  if (sum) sum.textContent = S.conversations.length ? `${S.conversations.length} conversation${S.conversations.length === 1 ? '' : 's'}` : 'Pick up where you left off.';
  if (!list.length) {
    host.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ico', text: '💬' }), h('div', { class: 'empty-title', text: q ? 'No matches' : 'No conversations yet' }), h('div', { class: 'empty-text', text: q ? 'Try a different word.' : 'Your chats with Cairn will show up here.' })));
    return;
  }
  host.replaceChildren(
    ...list.map((c) => {
      const id = String(c.id);
      const busy = activeRunsForConversation(id).length > 0;
      const confirming = pendingDelete.has(id);
      const updated = toMs(c.updatedAt);
      return h(
        'div',
        { class: `row conv-row${id === S.conversationId ? ' is-current' : ''}`, dataset: { convId: id } },
        h('span', { class: 'row-ico', text: /^scheduled:/i.test(c.title || '') ? '⏰' : '💬' }),
        h(
          'div',
          { class: 'row-main' },
          h('button', { type: 'button', class: 'row-title', title: c.title || '', onclick: () => openConversation(id), text: c.title || 'Untitled conversation' }),
          h('div', { class: 'row-meta' }, busy ? stateChip('running') : null, updated ? h('span', { class: 'meta-item', text: timeAgo(updated) }) : null, c.messageCount !== undefined ? h('span', { class: 'meta-item', text: `${c.messageCount} message${c.messageCount === 1 ? '' : 's'}` }) : null),
        ),
        h(
          'div',
          { class: 'row-actions' },
          confirming
            ? [btn('Delete', { cls: 'btn btn-small btn-danger', onClick: () => deleteConversation(id) }), btn('Keep', { cls: 'btn btn-small', onClick: () => { pendingDelete.delete(id); renderHistory(); } })]
            : iconBtn('trash', 'Delete conversation', () => { pendingDelete.add(id); renderHistory(); setTimeout(() => { if (pendingDelete.delete(id)) renderHistory(); }, 5000); }, 'danger'),
        ),
      );
    }),
  );
}

async function deleteConversation(id) {
  pendingDelete.delete(id);
  try {
    await api(`${API}/conversations/${enc(id)}`, { method: 'DELETE', body: {} });
    S.conversations = S.conversations.filter((c) => String(c.id) !== id);
    if (S.conversationId === id) {
      S.viewToken++;
      closeRunViews();
      clearThread();
      showWelcome(true);
      setConversationId(null);
    }
    renderHistory();
    toast('Conversation deleted', { kind: 'success', timeout: 2000 });
  } catch (e) {
    toast(`Couldn't delete: ${e.message}`, { kind: 'error' });
    renderHistory();
  }
}

/* ========================================================== global events */

let globalES = null;
let globalRetryMs = 3000;

function connectGlobalEvents() {
  if (typeof EventSource !== 'function') return;
  if (globalES) globalES.close();
  const es = new EventSource(`${API}/events`);
  globalES = es;
  let opened = false;
  es.addEventListener('open', () => {
    const reconnect = S.globalLive === false && opened;
    opened = true;
    S.globalLive = true;
    globalRetryMs = 3000;
    setOnline(true);
    if (reconnect) resync();
  });
  for (const type of GLOBAL_EVENT_TYPES) es.addEventListener(type, (ev) => onGlobalEvent(type, ev.data));
  es.addEventListener('message', (ev) => onGlobalEvent(null, ev.data));
  es.addEventListener('error', (ev) => {
    if (typeof ev.data === 'string' && ev.data) return; // a server-sent "error" event; nothing to do globally
    S.globalLive = false;
    if (es.readyState === 2) {
      // Permanently closed (e.g. 404 before the routes are wired): retry with backoff.
      es.close();
      if (globalES === es) globalES = null;
      setTimeout(connectGlobalEvents, globalRetryMs);
      globalRetryMs = Math.min(globalRetryMs * 2, 60000);
      refreshHealth();
    }
  });
}

function onGlobalEvent(type, data) {
  let d;
  try {
    d = typeof data === 'string' && data ? JSON.parse(data) : {};
  } catch {
    return;
  }
  if (!d || typeof d !== 'object') return;
  const t = type || d.type;
  switch (t) {
    case 'hello': {
      for (const raw of Array.isArray(d.pendingApprovals) ? d.pendingApprovals : []) upsertApproval(raw);
      for (const raw of Array.isArray(d.runs) ? d.runs : []) mergeRun(normalizeRun(raw), { fromPoll: true });
      scheduleActivityRender();
      renderHealth();
      break;
    }
    case 'tasks_changed':
    case 'task_started':
      debounced('tasks', refreshTasks);
      break;
    case 'shopping_changed':
      debounced('shopping', refreshShopping);
      break;
    case 'task_error': {
      const task = d.task || {};
      pushAlert({ key: `err-${task.id || ''}-${Date.now()}`, kind: 'error', kicker: 'Scheduled task failed', title: task.title || 'Scheduled task', message: d.message || '' });
      debounced('tasks', refreshTasks);
      break;
    }
    case 'notification':
      if (d.title || d.message) toast([d.title, d.message].filter(Boolean).join(' — '), { kind: 'info', timeout: 6000 });
      break;
    case 'reminder': {
      const task = d.task || d;
      const title = task.title || 'Reminder';
      pushAlert({ key: `rem-${task.id || title}-${Date.now()}`, kind: 'reminder', title, message: task.notes || '', task, at: Date.now() });
      postNative({ type: 'attention', title: `Reminder: ${title}`, message: task.notes || title });
      refreshTasks();
      break;
    }
    case 'task_result': {
      const task = d.task || {};
      const text = plainText(d.text || '');
      pushAlert({ key: `res-${task.id || ''}-${Date.now()}`, kind: d.ok === false ? 'error' : 'result', kicker: d.ok === false ? 'Scheduled task failed' : 'Scheduled task finished', title: task.title || 'Scheduled task', message: text, conversationId: d.conversationId || null });
      refreshTasks();
      refreshRuns();
      break;
    }
    case 'approval': {
      upsertApproval(d, { notify: true });
      break;
    }
    case 'approval_resolved': {
      const id = d.id ?? d.approval?.id;
      if (id === undefined) break;
      const allow = d.allow ?? d.decision?.allow;
      markApprovalResolved(id, allow ? 'approved' : allow === false ? 'denied' : 'expired');
      break;
    }
    case 'run_started': {
      const r = normalizeRun(d);
      if (!r.runId) break;
      if (!r.state) r.state = 'running';
      const known = S.runs.has(r.runId);
      mergeRun(r);
      // Runs started from this panel get their own toast; wait briefly so a
      // run_started that beats the POST /chat response is not announced twice.
      if (!known) {
        setTimeout(() => {
          if (!S.myRuns.has(r.runId)) toast(`Started in the background: ${truncate(S.runs.get(r.runId)?.title || r.title || 'task', 50)}`, { kind: 'info', action: { label: 'Activity', fn: () => showTab('activity') } });
        }, 1500);
      }
      scheduleActivityRender();
      renderHealth();
      break;
    }
    case 'run_update':
    case 'run_done': {
      const r = normalizeRun(d);
      if (!r.runId) break;
      if (t === 'run_done' && !r.state) r.state = 'done';
      if (t === 'run_done' && !r.finishedAt) r.finishedAt = Date.now();
      mergeRun(r);
      scheduleActivityRender();
      renderHealth();
      if (t === 'run_done') refreshHistory();
      break;
    }
    default:
      break;
  }
}

/* ============================================================== plumbing */

const debounceTimers = new Map();
function debounced(key, fn, ms = 250) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms));
}

async function resync() {
  await Promise.allSettled([refreshRuns(), refreshApprovals(), refreshTasks(), refreshShopping(), refreshHistory()]);
  const rv = [...S.runViews.values()];
  for (const v of rv) if (!v.finished && !v.es) v.connect();
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-since]')) {
    const since = Number(el.dataset.since);
    const until = el.dataset.until ? Number(el.dataset.until) : now;
    if (since) el.textContent = formatDuration(until - since);
  }
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - now;
    el.textContent = left > 0 ? `Auto-denies in ${formatDuration(left)}` : 'Timing out…';
  }
  updateRunBar();
}

function setupTabs() {
  for (const t of TABS) $(`#tab-${t}`)?.addEventListener('click', () => showTab(t));
  $('.tabs')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.indexOf(S.tab);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    showTab(TABS[n], { focus: true });
  });
}

function setupHeader() {
  for (const el of document.querySelectorAll('[data-icon]')) el.prepend(icon(el.dataset.icon, el.id === 'btn-send' ? 18 : 16));
  $('#btn-new-chat')?.addEventListener('click', () => newChat());
  const collapse = $('#btn-collapse');
  if (collapse) {
    collapse.hidden = !isNative();
    collapse.addEventListener('click', () => postNative({ type: 'collapse' }));
  }
  $('#btn-dashboard')?.addEventListener('click', (e) => {
    if (!isNative()) return;
    e.preventDefault();
    api(`${API}/open`, { method: 'POST', body: { url: `${location.origin}/` } }).catch(() => toast('Open http://127.0.0.1:8787/ in your browser for the dashboard.', { kind: 'info' }));
  });
  for (const id of ['#btn-refresh-runs', '#btn-refresh-tasks', '#btn-refresh-shopping', '#btn-refresh-history']) {
    $(id)?.addEventListener('click', () => {
      if (id.includes('runs')) refreshRuns();
      else if (id.includes('tasks')) refreshTasks();
      else if (id.includes('shopping')) refreshShopping();
      else refreshHistory();
    });
  }
  $('#history-filter')?.addEventListener('input', renderHistory);
}

function setupGlobalKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.value) {
        t.blur();
        return;
      }
      if (postNative({ type: 'collapse' })) e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      showTab(TABS[Number(e.key) - 1]);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      newChat();
    }
  });
  // In the native shell, target=_blank links do nothing; route them to the default browser.
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || !isNative() || a.id === 'btn-dashboard') return;
    const href = a.getAttribute('href') || '';
    if (safeUrl(href)) {
      e.preventDefault();
      openExternal(href);
    }
  });
}

function boot() {
  if (S.booted || !$('#panel')) return;
  document.documentElement.classList.toggle('is-native', isNative());
  setupHeader();
  setupTabs();
  setupComposer();
  setupTasks();
  setupShopping();
  setupGlobalKeys();

  const savedTab = storeGet(STORE_TAB);
  showTab(TABS.includes(savedTab) ? savedTab : 'chat');
  renderActivity();
  renderTasks();
  renderShopping();
  renderHistory();
  renderAlerts();
  renderHealth();

  (async () => {
    await refreshHealth();
    await Promise.allSettled([refreshRuns(), refreshApprovals()]);
    for (const r of S.runs.values()) if (!isActiveState(r.state)) S.notifiedDone.add(r.runId);
    S.booted = true;
    let saved = storeGet(STORE_CONV);
    const listed = await refreshHistory();
    // The remembered conversation may be gone (deleted elsewhere, or a different data dir): start fresh
    // quietly instead of requesting it and logging a 404.
    if (saved && listed && !S.conversations.some((c) => String(c.id) === String(saved))) {
      setConversationId(null);
      saved = null;
    }
    if (saved) openConversation(saved);
    else showWelcome(true);
    refreshTasks();
    refreshShopping();
    connectGlobalEvents();
  })();

  setInterval(tick, 1000);
  setInterval(refreshHealth, 10000);
  setInterval(() => {
    if (!S.globalLive || activeRuns().length || S.tab === 'activity') refreshRuns();
    if (!S.globalLive) refreshApprovals();
  }, 5000);
  setInterval(() => {
    if (S.tab === 'tasks') renderTasks();
    if (S.tab === 'activity') renderActivity();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resync();
  });
  window.addEventListener('focus', () => refreshApprovals());

  // Hooks for the native shell (evaluateJavaScript) and for debugging.
  window.cairnBubble = {
    show: (tab = 'chat') => showTab(tab),
    focusComposer: () => {
      showTab('chat');
      $('#composer-input')?.focus();
    },
    prefill: (text) => prefill(String(text ?? '')),
    newChat: () => newChat(),
    refresh: () => resync(),
    openConversation: (id) => openConversation(String(id)),
  };
  const header = document.querySelector('[data-drag-region]');
  postNative({ type: 'ready', dragRegionHeight: header ? Math.round(header.getBoundingClientRect().height) : 52 });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
