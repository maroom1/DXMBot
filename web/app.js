// Cairn dashboard — vanilla ES module, zero dependencies.
//
// Security rule for this file: server-provided data only ever reaches the DOM
// through nodes we build ourselves (textContent / setAttribute). innerHTML is
// never used, and every href derived from server data goes through safeHref().

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  return append(el, children);
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Only http(s) URLs and same-origin paths are ever used as link targets.
function safeHref(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  // Browsers read "\" as "/" in http(s) URLs ("/\\evil.com" is "//evil.com") and
  // strip tabs/newlines, so such values could leave the site: refuse them.
  if (/[\\\u0000-\u001f\u007f]/.test(u)) return null;
  if (/^https?:\/\//i.test(u)) {
    try {
      return new URL(u).href;
    } catch {
      return null;
    }
  }
  if (u.startsWith('#')) return u;
  if (/^\/(?!\/)/.test(u)) {
    // Relative links must stay on this origin once resolved.
    try {
      const resolved = new URL(u, location.origin);
      return resolved.origin === location.origin ? resolved.pathname + resolved.search + resolved.hash : null;
    } catch {
      return null;
    }
  }
  return null;
}

function extLink(url, text, cls) {
  const href = safeHref(url);
  const label = text ?? url ?? '';
  if (!href) return h('span', { class: cls, text: label });
  const external = /^https?:/i.test(href);
  return h('a', { href, class: cls, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null, text: label });
}

function chip(text, color = 'gray', title) {
  return h('span', { class: `chip chip-${color}`, text, title });
}

function code(text, cls) {
  return h('code', { class: cls, text: text ?? '' });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function truncate(s, n = 120) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

const nf = new Intl.NumberFormat();
function fmtNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : n === 0 ? '0' : '—';
}

function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function toDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

function fmtDateTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function fmtRelative(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (Math.abs(s) < 45) return s >= 0 ? 'just now' : 'in a moment';
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
  for (const [unit, sec] of units) {
    if (Math.abs(s) >= sec) return rtf.format(-Math.round(s / sec), unit);
  }
  return rtf.format(-s, 'second');
}

function fmtUsd(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 3)}` : null;
}

function parseData(e) {
  if (!e || typeof e.data !== 'string' || e.data === '') return {};
  try {
    return JSON.parse(e.data);
  } catch {
    return { message: e.data };
  }
}

// Pick a human-readable string out of a loosely shaped event payload.
function pickText(d, ...keys) {
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  for (const k of keys.length ? keys : ['message', 'text', 'status', 'detail', 'phase', 'stage']) {
    if (typeof d[k] === 'string' && d[k]) return d[k];
  }
  return '';
}

async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'success', 2000);
  } catch {
    toast('Clipboard is not available in this browser context', 'error');
  }
}

function copyButton(getText, label = 'Copy') {
  return h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-xs',
    text: label,
    onclick: () => copyText(typeof getText === 'function' ? getText() : getText, 'Copied'),
  });
}

function jsonBlock(value) {
  return h('pre', { class: 'code-block', text: JSON.stringify(value, null, 2) });
}

function emptyState(text) {
  return h('div', { class: 'empty-state', text });
}

function loading(text = 'Loading…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', { text }));
}

function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    dl.append(h('dt', { text: k }), h('dd', {}, v === null || v === '' ? h('span', { class: 'muted', text: '—' }) : v));
  }
  return dl;
}

function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h2', { class: 'card-title', text: title }) : null, ...body);
}

function headersTable(headers, { note } = {}) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return emptyState('No headers.');
  const tbody = h('tbody');
  for (const [k, v] of entries) {
    tbody.append(h('tr', {}, h('th', { scope: 'row', class: 'mono hdr-name', text: k }), h('td', { class: 'mono hdr-value', text: Array.isArray(v) ? v.join(', ') : String(v) })));
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data-table headers-table' }, tbody), note ? h('p', { class: 'table-note muted', text: note }) : null);
}

/* ---------------------------------------------------------------------- API */

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body, query, signal } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const init = { method, headers: { Accept: 'application/json' }, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the Cairn server', 0, null);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || `${res.status} ${res.statusText || 'error'}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/* ------------------------------------------------------------------- toasts */

function toast(message, type = 'info', timeout = 5000) {
  const box = $('#toasts');
  const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×' });
  const t = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, h('span', { class: 'toast-msg', text: message }), close);
  const remove = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  };
  close.addEventListener('click', remove);
  box.append(t);
  while (box.children.length > 5) box.firstElementChild.remove();
  if (timeout) setTimeout(remove, timeout);
}

function reportError(err, context) {
  if (err && err.name === 'AbortError') return;
  const msg = err && err.message ? err.message : String(err);
  toast(context ? `${context}: ${msg}` : msg, 'error', 7000);
}

/* ------------------------------------------------------------------- drawer */

const drawer = {
  onClose: null,
  open(title, content, { onClose } = {}) {
    $('#drawer-title').textContent = title;
    $('#drawer-body').replaceChildren(content);
    this.onClose = onClose || null;
    const d = $('#drawer');
    d.hidden = false;
    requestAnimationFrame(() => d.classList.add('open'));
    $('.drawer-panel .icon-btn').focus();
  },
  close() {
    const d = $('#drawer');
    if (d.hidden) return;
    d.classList.remove('open');
    setTimeout(() => {
      d.hidden = true;
      $('#drawer-body').replaceChildren();
    }, 180);
    if (this.onClose) this.onClose();
    this.onClose = null;
  },
  init() {
    $('#drawer').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },
};

/* ---------------------------------------------------------------- markdown */
// Minimal, safe markdown: we never produce HTML strings; every piece of text
// becomes a text node, so escaping is inherent. Supports headings, paragraphs,
// bold/italic/strike, inline + fenced code, lists (nested), blockquotes,
// tables, links (http/https only) and [n] citations.

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const INLINE_RE = new RegExp(
  [
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1,2 code span
    /!\[([^\]\n]*)\]\(([^)\s]*)[^)\n]*\)/.source, // 3,4 image (rendered as text)
    /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)/.source, // 5,6 link
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 7 bold
    /\*(?=[^\s*])([^*\n]*?[^\s*])\*/.source, // 8 italic
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 9 strike
    /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/.source, // 10 citation(s)
    /(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/.source, // 11 bare URL
  ].join('|'),
  'g',
);

function renderInline(text, cites) {
  const frag = document.createDocumentFragment();
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) frag.append(h('code', { class: 'md-code', text: m[2] }));
    else if (m[4] !== undefined) frag.append(h('span', { class: 'md-img', text: `[image${m[3] ? `: ${m[3]}` : ''}]` }));
    else if (m[6] !== undefined) frag.append(mdLink(m[6], renderInline(m[5], cites)));
    else if (m[7] !== undefined) frag.append(h('strong', {}, renderInline(m[7], cites)));
    else if (m[8] !== undefined) frag.append(h('em', {}, renderInline(m[8], cites)));
    else if (m[9] !== undefined) frag.append(h('del', {}, renderInline(m[9], cites)));
    else if (m[10] !== undefined) frag.append(citationNodes(m[0], m[10], cites));
    else if (m[11] !== undefined) frag.append(mdLink(m[11], m[11]));
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function mdLink(url, content) {
  const href = safeHref(url);
  if (!href) return h('span', {}, content);
  const external = /^https?:/i.test(href);
  return h('a', { href, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer nofollow' : null }, content);
}

function citationNodes(raw, list, cites) {
  if (!cites || !cites.size) return document.createTextNode(raw);
  const nums = list.split(/\s*[,;]\s*/).map(Number);
  if (!nums.some((n) => cites.has(n))) return document.createTextNode(raw);
  const frag = document.createDocumentFragment();
  for (const n of nums) {
    const c = cites.get(n);
    if (!c) {
      frag.append(`[${n}]`);
      continue;
    }
    const href = safeHref(c.url);
    const title = [c.title, c.url].filter(Boolean).join(' — ');
    const a = href
      ? h('a', { class: 'cite', href, target: '_blank', rel: 'noopener noreferrer', title, dataset: { n: String(n) }, text: String(n) })
      : h('span', { class: 'cite', title, dataset: { n: String(n) }, text: String(n) });
    frag.append(h('sup', { class: 'cite-wrap' }, a));
  }
  return frag;
}

function isBlockStart(line, next) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseList(lines, start, inl) {
  const first = lines[start].match(LIST_RE);
  const mk = (ordered) => h(ordered ? 'ol' : 'ul', { class: 'md-list' });
  const stack = [{ indent: first[1].length, list: mk(/\d/.test(first[2])) }];
  const rootOrdered = /\d/.test(first[2]);
  // A root-level item with a different marker kind (bullet vs number) starts a new list.
  const continuesRoot = (mm) => mm[1].length > stack[0].indent || /\d/.test(mm[2]) === rootOrdered;
  let i = start;
  let lastLi = null;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    if (m && !continuesRoot(m)) break;
    if (!m) {
      if (!line.trim()) {
        const next = i + 1 < lines.length ? lines[i + 1].match(LIST_RE) : null;
        if (next && continuesRoot(next)) {
          i++;
          continue;
        }
        break;
      }
      if (/^\s+\S/.test(line) && lastLi) {
        lastLi.append(' ', inl(line.trim()));
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].length;
    const ordered = /\d/.test(m[2]);
    let top = stack[stack.length - 1];
    if (indent > top.indent + 1 && lastLi) {
      const list = mk(ordered);
      lastLi.append(list);
      stack.push({ indent, list });
      top = stack[stack.length - 1];
    } else {
      while (stack.length > 1 && indent < top.indent) {
        stack.pop();
        top = stack[stack.length - 1];
      }
    }
    if (ordered && top.list.tagName === 'OL' && !top.list.children.length) {
      const n = parseInt(m[2], 10);
      if (n !== 1) top.list.start = n;
    }
    let body = m[3];
    let checkbox = null;
    const task = body.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checkbox = h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' });
      body = task[2];
    }
    lastLi = h('li', {}, checkbox, checkbox ? ' ' : null, inl(body));
    top.list.append(lastLi);
    i++;
  }
  return [stack[0].list, i];
}

function renderMarkdown(src, opts = {}) {
  const frag = document.createDocumentFragment();
  const cites = opts.citations && opts.citations.length ? new Map(opts.citations.map((c) => [Number(c.n), c])) : null;
  const inl = (t) => renderInline(t, cites);
  const offset = opts.headingOffset ?? 2;
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
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
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      const c = h('code', { text: buf.join('\n') });
      if (m[2]) c.dataset.lang = m[2];
      frag.append(h('pre', { class: 'md-pre' }, c));
      continue;
    }
    m = line.match(HEADING_RE);
    if (m) {
      const level = Math.min(6, m[1].length + offset);
      frag.append(h(`h${level}`, { class: 'md-h' }, inl(m[2])));
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      frag.append(h('hr'));
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      frag.append(h('blockquote', {}, renderMarkdown(buf.join('\n'), opts)));
      continue;
    }
    if (LIST_RE.test(line)) {
      const [node, next] = parseList(lines, i, inl);
      frag.append(node);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const tbody = h('tbody');
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++]);
        tbody.append(h('tr', {}, head.map((_, j) => h('td', {}, inl(cells[j] ?? '')))));
      }
      frag.append(
        h('div', { class: 'table-wrap' }, h('table', { class: 'md-table' }, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inl(c))))), tbody)),
      );
      continue;
    }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++].trim());
    frag.append(h('p', {}, inl(buf.join(' '))));
  }
  return frag;
}

/* --------------------------------------------------------- term highlighting */

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i if in into is it its of on or s so than that the their them then there these they this to was were what when where which who whom why will with you your does do did can could should would about'.split(' '),
);

function queryStems(q) {
  const out = new Set();
  for (const raw of String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    let w = raw;
    for (const suf of ['ies', 'ing', 'es', 'ed', 's']) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) {
        w = w.slice(0, -suf.length);
        break;
      }
    }
    out.add(w);
  }
  return [...out];
}

function highlight(text, stems) {
  const frag = document.createDocumentFragment();
  const s = String(text ?? '');
  if (!stems.length) {
    frag.append(s);
    return frag;
  }
  // Split keeps the captured word tokens at odd indices.
  const parts = s.split(/([\p{L}\p{N}]+)/u);
  let buf = '';
  parts.forEach((part, idx) => {
    const lw = part.toLowerCase();
    if (idx % 2 === 1 && stems.some((st) => lw.startsWith(st))) {
      if (buf) frag.append(buf);
      buf = '';
      frag.append(h('mark', { text: part }));
    } else {
      buf += part;
    }
  });
  if (buf) frag.append(buf);
  return frag;
}

/* ------------------------------------------------------------ shared state */

const state = {
  health: null,
  identity: null,
  config: null,
};

const ROLE_LABEL = { search: 'CairnSearch', corpus: 'CairnCorpus', user: 'Cairn-User' };
const ROLE_COLOR = { search: 'blue', corpus: 'purple', user: 'teal' };

function roleChip(role) {
  if (!role) return h('span', { class: 'muted', text: '—' });
  return chip(ROLE_LABEL[role] || role, ROLE_COLOR[role] || 'gray', role);
}

function outcomeColor(outcome) {
  const o = String(outcome || '');
  if (o === 'indexed') return 'green';
  if (o === 'collected') return 'teal';
  if (o === 'blocked-robots') return 'red';
  if (o === 'noindex') return 'purple';
  if (o === 'duplicate') return 'gray';
  if (o === 'skipped-type') return 'slate';
  if (o === 'error') return 'red';
  if (/^http-3/.test(o)) return 'blue';
  if (/^http-4/.test(o)) return 'amber';
  if (/^http-5/.test(o)) return 'red';
  return 'gray';
}

function statusColor(status) {
  if (status === null || status === undefined || status === 0) return 'gray';
  if (status < 300) return 'green';
  if (status < 400) return 'blue';
  if (status < 500) return 'amber';
  return 'red';
}

function robotsRuleText(rule) {
  if (!rule || !rule.type) return null;
  const t = rule.type === 'allow' ? 'Allow' : rule.type === 'disallow' ? 'Disallow' : rule.type;
  return `${t}: ${rule.path ?? ''}`;
}

async function getConfig(force = false) {
  if (!state.config || force) state.config = await api('/api/config').then((d) => (d && d.config && typeof d.config === 'object' ? d.config : d));
  return state.config;
}

/* ------------------------------------------------------------------ health */

async function refreshHealth() {
  const pill = $('#health-pill');
  const text = $('.pill-text', pill);
  try {
    const data = await api('/api/health');
    state.health = data;
    updateOptionalLinks(data);
    const c = (data && data.claude) || {};
    if (c.available) {
      pill.className = 'pill pill-ok';
      text.textContent = 'Claude CLI ready';
      pill.title = [`Claude CLI available${c.version ? ` (${c.version})` : ''}`, c.bin ? `binary: ${c.bin}` : ''].filter(Boolean).join('\n');
    } else {
      pill.className = 'pill pill-warn';
      text.textContent = 'Claude CLI unavailable';
      pill.title = `${c.error || 'The claude binary was not found.'}\nQuick answers fall back to extractive mode; deep research needs the CLI.`;
    }
    const v = $('#app-version');
    if (data && data.version) {
      v.textContent = `v${String(data.version).replace(/^v/, '')}`;
      v.hidden = false;
    }
  } catch {
    state.health = null;
    pill.className = 'pill pill-bad';
    text.textContent = 'Server offline';
    pill.title = 'The Cairn API is not responding.';
  }
  ask.updateHint();
}

/* --------------------------------------------------------------- assistant */

// Header "Assistant" button: badge with pending approvals; "Avatars" link only
// when the avatar gallery is installed.
async function refreshAssistantBadge() {
  const badge = $('#assistant-badge');
  const link = $('#assistant-link');
  if (!badge || !link) return;
  try {
    const h = await api('/api/assistant/health');
    const pending = Number(h?.pendingApprovals) || 0;
    const running = Number(h?.runningRuns) || 0;
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? '99+' : String(pending);
    const bits = [pending ? `${pending} approval${pending === 1 ? '' : 's'} waiting` : '', running ? `${running} task${running === 1 ? '' : 's'} running` : ''].filter(Boolean);
    link.title = bits.length ? `Open the Cairn assistant — ${bits.join(', ')}` : 'Open the Cairn assistant (chat, reminders, tasks, shopping)';
  } catch {
    badge.hidden = true;
  }
}

// /api/health reports which optional UI pieces are installed.
function updateOptionalLinks(health) {
  const avatars = $('#avatars-link');
  if (avatars) avatars.hidden = !health?.ui?.avatarGallery;
}

/* --------------------------------------------------------------------- ASK */

const ask = {
  mode: 'quick',
  active: null, // { es, finish }
  msgSeq: 0,

  init() {
    const form = $('#ask-form');
    const input = $('#ask-input');
    $$('.segmented [data-mode]', form).forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode;
        $$('.segmented [data-mode]', form).forEach((x) => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
        this.updateHint();
        input.focus();
      }),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || this.active) return;
      input.value = '';
      this.autosize();
      this.send(q);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('input', () => this.autosize());
    $('#ask-suggestions').addEventListener('click', (e) => {
      const b = e.target.closest('.suggestion');
      if (b && !this.active) this.send(b.textContent.trim());
    });
    $('#ask-stop').addEventListener('click', () => this.active && this.active.stop());
    $('#ask-clear').addEventListener('click', () => {
      if (this.active) this.active.stop();
      $$('#ask-thread > .msg').forEach((m) => m.remove());
      $('#ask-empty').hidden = false;
    });
    this.updateHint();
  },

  enter() {
    setTimeout(() => $('#ask-input').focus(), 0);
  },

  autosize() {
    const t = $('#ask-input');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  },

  updateHint() {
    const hint = $('#ask-hint');
    if (!hint) return;
    const claude = state.health && state.health.claude;
    if (this.mode === 'deep') {
      hint.textContent =
        claude && !claude.available
          ? 'Deep research needs the Claude CLI, which is not available on this server.'
          : 'Claude research agent: searches the index, fetches pages as Cairn-User (robots.txt respected) and runs small crawls via MCP tools.';
      hint.classList.toggle('warn', Boolean(claude && !claude.available));
    } else {
      hint.textContent =
        claude && !claude.available
          ? 'Answers from your local index. Claude CLI unavailable: using an extractive answer with citations.'
          : 'Answers only from your local index, with [n] citations.';
      hint.classList.remove('warn');
    }
  },

  setBusy(busy) {
    $('#ask-send').disabled = busy;
    $('#ask-stop').hidden = !busy;
    $$('#ask-suggestions .suggestion').forEach((b) => (b.disabled = busy));
  },

  scroll(force = false) {
    const el = document.scrollingElement || document.documentElement;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (force || nearBottom) window.scrollTo({ top: el.scrollHeight, behavior: force ? 'smooth' : 'auto' });
  },

  createMessage(mode) {
    const id = `m${++this.msgSeq}`;
    const statusText = h('span', { class: 'status-text', text: 'Connecting…' });
    const spinner = h('span', { class: 'spinner' });
    const status = h('span', { class: 'msg-status' }, spinner, statusText);
    const head = h(
      'div',
      { class: 'msg-head' },
      h('span', { class: 'msg-author', text: 'Cairn' }),
      chip(mode === 'deep' ? 'Deep research' : 'Quick', mode === 'deep' ? 'purple' : 'blue'),
      status,
    );
    const m = {
      id,
      mode,
      statusText,
      spinner,
      retrieval: h('div', { class: 'retrieval', hidden: true }),
      timeline: h('ol', { class: 'timeline', hidden: true }),
      draft: h('div', { class: 'md draft', hidden: true }),
      answer: h('div', { class: 'md answer', hidden: true }),
      sources: h('div', { class: 'sources', hidden: true }),
      meta: h('div', { class: 'msg-meta', hidden: true }),
      error: h('div', { class: 'msg-error', role: 'alert', hidden: true }),
      draftText: '',
      steps: [],
      stepSeq: 0,
    };
    m.el = h('article', { class: 'msg msg-assistant', id }, head, m.retrieval, m.timeline, m.draft, m.error, m.answer, m.sources, m.meta);
    return m;
  },

  setStatus(m, text) {
    if (text) m.statusText.textContent = text;
  },

  showError(m, message) {
    m.error.hidden = false;
    m.error.textContent = message;
  },

  addRetrieval(m, d) {
    const passages = Array.isArray(d.passages) ? d.passages : Array.isArray(d.results) ? d.results : null;
    const count = passages ? passages.length : typeof d.count === 'number' ? d.count : typeof d.passages === 'number' ? d.passages : null;
    m.retrieval.replaceChildren();
    m.retrieval.hidden = false;
    const label = count === null ? pickText(d) || 'Retrieved passages from the index' : count === 0 ? 'No relevant passages in the index' : `Retrieved ${count} passage${count === 1 ? '' : 's'} from the index`;
    if (passages && passages.length) {
      const seen = new Map();
      for (const p of passages) if (p && p.url && !seen.has(p.url)) seen.set(p.url, p);
      const list = h('ul', { class: 'retrieval-list' }, [...seen.values()].map((p) => h('li', {}, extLink(p.url, p.title || p.url), h('span', { class: 'muted', text: ` ${hostOf(p.url)}` }))));
      m.retrieval.append(h('details', {}, h('summary', { text: label }), list));
    } else {
      m.retrieval.append(h('div', { class: 'retrieval-summary', text: label }));
    }
  },

  toolLabel(name) {
    return String(name || 'tool').replace(/^mcp__cairn__/, '').replace(/^mcp__[^_]+__/, '');
  },

  toolInputSummary(input) {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'object') return String(input);
    for (const k of ['query', 'url', 'q', 'question']) if (typeof input[k] === 'string') return input[k];
    return truncate(JSON.stringify(input), 160);
  },

  addStep(m, d, { ts } = {}) {
    m.timeline.hidden = false;
    const name = this.toolLabel(d.name || d.tool);
    const input = d.input ?? d.args ?? d.arguments;
    const result = h('div', { class: 'step-result' });
    const li = h(
      'li',
      { class: 'step pending' },
      h('span', { class: 'step-dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'step-body' },
        h('div', { class: 'step-line' }, h('span', { class: 'step-name', text: name }), h('span', { class: 'step-input mono', text: this.toolInputSummary(input) }), h('span', { class: 'step-time muted', text: fmtTime(ts || d.ts || Date.now()) })),
        result,
      ),
    );
    m.timeline.append(li);
    const step = { id: d.id || d.toolUseId || d.tool_use_id || `s${++m.stepSeq}`, li, result, done: false };
    m.steps.push(step);
    if (d.summary) this.completeStep(m, { summary: d.summary }, step);
    return step;
  },

  completeStep(m, d, step) {
    const id = d.id || d.toolUseId || d.tool_use_id;
    const target = step || (id && m.steps.find((s) => s.id === id)) || m.steps.find((s) => !s.done);
    if (!target) return;
    target.done = true;
    target.li.classList.remove('pending');
    const isError = Boolean(d.isError || d.is_error || d.error);
    target.li.classList.add(isError ? 'failed' : 'ok');
    let content = d.summary ?? d.text ?? d.content ?? d.result ?? d.output ?? (typeof d.error === 'string' ? d.error : '');
    if (Array.isArray(content)) content = content.map((c) => (c && typeof c.text === 'string' ? c.text : typeof c === 'string' ? c : JSON.stringify(c))).join('\n');
    else if (content && typeof content === 'object') content = JSON.stringify(content, null, 2);
    content = String(content || '');
    if (!content) return;
    const firstLine = truncate(content.split('\n').find((l) => l.trim()) || content, 140);
    if (content.length <= 140 && !content.includes('\n')) target.result.replaceChildren(h('span', { class: 'step-summary', text: content }));
    else target.result.replaceChildren(h('details', {}, h('summary', { class: 'step-summary', text: firstLine }), h('pre', { class: 'code-block small', text: truncate(content, 4000) })));
  },

  appendDraft(m, d) {
    const piece = typeof d === 'string' ? d : typeof d.delta === 'string' ? d.delta : pickText(d, 'text', 'content', 'message');
    if (!piece) return;
    if (typeof d === 'object' && typeof d.delta === 'string') m.draftText += piece;
    else m.draftText += (m.draftText ? '\n\n' : '') + piece;
    m.draft.hidden = false;
    m.draft.replaceChildren(renderMarkdown(m.draftText));
  },

  renderAnswer(m, raw) {
    const result = raw && raw.result && typeof raw.result === 'object' ? raw.result : raw || {};
    const citations = Array.isArray(result.citations) ? result.citations.filter((c) => c && c.n !== undefined) : [];
    m.answer.replaceChildren(renderMarkdown(result.answer || '_No answer was returned._', { citations }));
    m.answer.hidden = false;
    m.draft.hidden = true;

    // Streamed tool events normally build the timeline; the final `steps`
    // array (tool + tool_result entries) is the fallback when none arrived.
    if (!m.steps.length && Array.isArray(result.steps) && result.steps.length) {
      for (const s of result.steps) {
        if (s.type === 'tool_result') this.completeStep(m, { id: s.id, summary: s.summary, isError: s.isError });
        else if (!s.type || s.type === 'tool') this.addStep(m, { id: s.id, name: s.name, input: s.input }, { ts: s.ts });
      }
    }
    m.steps.filter((s) => !s.done).forEach((s) => {
      s.done = true;
      s.li.classList.remove('pending');
      s.li.classList.add('ok');
    });

    if (citations.length) {
      const list = h('ol', { class: 'source-list' });
      for (const c of citations) {
        list.append(
          h(
            'li',
            { dataset: { n: String(c.n) } },
            h('span', { class: 'src-n', text: String(c.n) }),
            h('div', { class: 'src-body' }, extLink(c.url, c.title || c.url, 'src-title'), h('span', { class: 'src-url muted', text: truncate(c.url, 90) })),
          ),
        );
      }
      m.sources.replaceChildren(h('h4', { text: 'Sources' }), list);
      m.sources.hidden = false;
      // Hovering a citation highlights its source entry.
      m.answer.addEventListener('mouseover', (e) => {
        const a = e.target.closest('.cite');
        $$('li', list).forEach((li) => li.classList.toggle('hl', Boolean(a) && li.dataset.n === a.dataset.n));
      });
      m.answer.addEventListener('mouseleave', () => $$('li', list).forEach((li) => li.classList.remove('hl')));
    }

    const bits = [];
    if (result.usedClaude === true) bits.push(chip('Claude', 'teal', 'Answer generated by the Claude CLI from the cited sources'));
    else if (result.usedClaude === false) bits.push(chip('Extractive fallback', 'amber', 'Claude was unavailable or failed; showing the most relevant passages'));
    if (result.model) bits.push(h('span', { text: String(result.model) }));
    const cost = fmtUsd(result.costUsd);
    if (cost) bits.push(h('span', { text: cost, title: 'Claude CLI reported cost' }));
    if (typeof result.elapsedMs === 'number') bits.push(h('span', { text: fmtMs(result.elapsedMs) }));
    const pc = Array.isArray(result.passages) ? result.passages.length : typeof result.passages === 'number' ? result.passages : null;
    if (pc !== null) bits.push(h('span', { text: `${pc} passage${pc === 1 ? '' : 's'}` }));
    if (m.steps.length) bits.push(h('span', { text: `${m.steps.length} tool call${m.steps.length === 1 ? '' : 's'}` }));
    const answerText = result.answer || '';
    bits.push(h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Copy answer', onclick: () => copyText(answerText, 'Answer copied') }));
    m.meta.replaceChildren(...bits);
    m.meta.hidden = false;
  },

  send(question) {
    $('#ask-empty').hidden = true;
    const mode = this.mode;
    const thread = $('#ask-thread');
    thread.append(h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble', text: question })));
    const m = this.createMessage(mode);
    thread.append(m.el);
    this.scroll(true);
    this.setBusy(true);

    const es = new EventSource(`/api/ask/stream?${new URLSearchParams({ question, mode })}`);
    let finished = false;
    let gotEvent = false;
    let gotAnswer = false;
    let errored = false;

    const finish = (label) => {
      if (finished) return;
      finished = true;
      es.close();
      m.spinner.remove();
      this.setStatus(m, label || (gotAnswer ? 'Done' : errored ? 'Failed' : 'Finished'));
      m.statusText.parentElement.classList.add(gotAnswer ? 'done' : 'ended');
      this.active = null;
      this.setBusy(false);
      this.scroll();
    };
    this.active = { stop: () => finish('Stopped') };

    const on = (type, fn) =>
      es.addEventListener(type, (e) => {
        if (finished) return;
        gotEvent = true;
        try {
          fn(parseData(e));
        } catch (err) {
          console.error(`ask: failed to handle ${type} event`, err);
        }
        this.scroll();
      });

    on('status', (d) => this.setStatus(m, pickText(d) || 'Working…'));
    on('retrieval', (d) => {
      this.addRetrieval(m, d);
      this.setStatus(m, mode === 'deep' ? 'Researching…' : 'Composing answer…');
    });
    on('tool', (d) => {
      this.addStep(m, d);
      this.setStatus(m, `Calling ${this.toolLabel(d.name || d.tool)}…`);
    });
    on('tool_result', (d) => {
      this.completeStep(m, d);
      this.setStatus(m, 'Thinking…');
    });
    on('text', (d) => this.appendDraft(m, d));
    on('answer', (d) => {
      gotAnswer = true;
      this.renderAnswer(m, d);
      this.setStatus(m, 'Done');
    });
    on('done', () => finish());

    es.addEventListener('error', (e) => {
      if (finished) return;
      if (typeof e.data === 'string') {
        // Server-sent "event: error" (a MessageEvent with data).
        gotEvent = true;
        errored = true;
        const d = parseData(e);
        const msg = pickText(d, 'error', 'message') || 'The answer could not be generated.';
        this.showError(m, msg);
        toast(msg, 'error', 7000);
        return;
      }
      // Transport error. EventSource would silently reconnect and re-run the
      // question, so we always close. If the stream endpoint failed before any
      // event arrived, fall back to the blocking POST /api/ask.
      if (!gotEvent && es.readyState === EventSource.CLOSED) {
        es.close();
        this.fallback(m, question, mode, finish);
        return;
      }
      if (!gotAnswer && !errored) this.showError(m, 'Connection to the server was lost before the answer finished.');
      finish();
    });
  },

  async fallback(m, question, mode, finish) {
    this.setStatus(m, 'Streaming unavailable; waiting for the full answer…');
    try {
      const result = await api('/api/ask', { method: 'POST', body: { question, mode } });
      this.renderAnswer(m, result);
      finish('Done');
    } catch (err) {
      this.showError(m, err.message);
      reportError(err, 'Ask failed');
      finish('Failed');
    }
  },
};

/* ------------------------------------------------------------------- CRAWL */

const COUNTERS = [
  ['discovered', 'Discovered'],
  ['queued', 'Queued'],
  ['fetched', 'Fetched'],
  ['indexed', 'Indexed'],
  ['collected', 'Collected'],
  ['blockedRobots', 'Blocked (robots)'],
  ['noindex', 'Noindex'],
  ['duplicates', 'Duplicates'],
  ['skipped', 'Skipped'],
  ['errors', 'Errors'],
];

const STATE_COLOR = { queued: 'gray', running: 'blue', done: 'green', cancelled: 'amber', error: 'red' };
const MAX_STREAMS = 3; // browsers allow ~6 HTTP/1.1 connections per origin; SSE holds one each.

const crawl = {
  jobs: new Map(),
  pollTimer: null,
  active: false,
  defaultsLoaded: false,

  init() {
    $('#crawl-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.start();
    });
    $('#crawl-refresh').addEventListener('click', () => this.load());
  },

  async enter() {
    this.active = true;
    if (!this.defaultsLoaded) {
      this.defaultsLoaded = true;
      getConfig()
        .then((cfg) => {
          const c = (cfg && cfg.crawl) || {};
          if (typeof c.maxPages === 'number') $('#crawl-max-pages').value = c.maxPages;
          if (typeof c.maxDepth === 'number') $('#crawl-max-depth').value = c.maxDepth;
          if (typeof c.sameSiteOnly === 'boolean') $('#crawl-same-site').checked = c.sameSiteOnly;
          if (typeof c.useSitemaps === 'boolean') $('#crawl-sitemaps').checked = c.useSitemaps;
        })
        .catch(() => {});
    }
    await this.load();
    this.pollTimer = setInterval(() => this.pollUnstreamed(), 2500);
  },

  leave() {
    this.active = false;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const j of this.jobs.values()) this.closeStream(j);
  },

  lines(id) {
    return $(id)
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  },

  async start() {
    const seeds = this.lines('#crawl-seeds');
    if (!seeds.length) return toast('Enter at least one seed URL', 'error');
    const bad = seeds.find((s) => !/^https?:\/\//i.test(s));
    if (bad) return toast(`Seed must be an http(s) URL: ${bad}`, 'error');
    const includePatterns = this.lines('#crawl-include');
    const excludePatterns = this.lines('#crawl-exclude');
    for (const p of [...includePatterns, ...excludePatterns]) {
      try {
        new RegExp(p);
      } catch {
        return toast(`Invalid regular expression: ${p}`, 'error');
      }
    }
    const body = {
      seeds,
      role: $('input[name="crawl-role"]:checked').value,
      maxPages: Number($('#crawl-max-pages').value) || undefined,
      maxDepth: $('#crawl-max-depth').value === '' ? undefined : Number($('#crawl-max-depth').value),
      sameSiteOnly: $('#crawl-same-site').checked,
      useSitemaps: $('#crawl-sitemaps').checked,
    };
    if (includePatterns.length) body.includePatterns = includePatterns;
    if (excludePatterns.length) body.excludePatterns = excludePatterns;
    const btn = $('#crawl-submit');
    btn.disabled = true;
    try {
      const data = await api('/api/crawl', { method: 'POST', body });
      const job = (data && data.job) || data;
      toast(`Crawl ${job.id} started as ${ROLE_LABEL[job.role] || job.role}`, 'success');
      this.upsert(job, { prepend: true, open: true });
      this.ensureStreams();
    } catch (err) {
      reportError(err, 'Could not start crawl');
    } finally {
      btn.disabled = false;
    }
  },

  async load() {
    try {
      const data = await api('/api/crawl');
      const jobs = (data && data.jobs) || [];
      const seen = new Set();
      jobs.forEach((job, idx) => {
        seen.add(job.id);
        this.upsert(job, { open: idx === 0 && !this.jobs.has(job.id) });
      });
      for (const [id, j] of this.jobs) {
        if (!seen.has(id)) {
          this.closeStream(j);
          j.el.remove();
          this.jobs.delete(id);
        }
      }
      this.sortCards(jobs.map((j) => j.id));
      this.renderEmpty();
      this.ensureStreams();
    } catch (err) {
      reportError(err, 'Could not load crawl jobs');
    }
  },

  sortCards(order) {
    const box = $('#crawl-jobs');
    for (const id of order) {
      const j = this.jobs.get(id);
      if (j) box.append(j.el);
    }
  },

  renderEmpty() {
    const box = $('#crawl-jobs');
    const empty = $(':scope > .empty-state', box);
    if (this.jobs.size && empty) empty.remove();
    if (!this.jobs.size && !empty) box.append(emptyState('No crawl jobs yet. Start one with the form.'));
  },

  isActive(status) {
    return status && (status.state === 'queued' || status.state === 'running');
  },

  upsert(status, { prepend = false, open = false } = {}) {
    if (!status || !status.id) return;
    let j = this.jobs.get(status.id);
    if (!j) {
      j = this.buildCard(status, open);
      this.jobs.set(status.id, j);
      const box = $('#crawl-jobs');
      if (prepend) box.prepend(j.el);
      else box.append(j.el);
      this.renderEmpty();
    }
    this.update(j, status);
    return j;
  },

  buildCard(status, open) {
    const j = { id: status.id, status, es: null, pages: [], pageKeys: new Set(), refreshPending: false };
    j.stateChip = h('span');
    j.title = h('div', { class: 'job-title' });
    j.sub = h('div', { class: 'job-sub muted' });
    j.cancelBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Cancel', onclick: () => this.cancel(j) });
    j.counterEls = {};
    const counters = h('div', { class: 'counters' });
    for (const [key, label] of COUNTERS) {
      const v = h('span', { class: 'counter-value', text: '0' });
      const cell = h('div', { class: `counter counter-${key}` }, v, h('span', { class: 'counter-label', text: label }));
      j.counterEls[key] = { cell, v };
      counters.append(cell);
    }
    j.bar = h('div', { class: 'progress-bar' });
    j.progressText = h('span', { class: 'muted' });
    j.inflight = h('div', { class: 'inflight' });
    j.errorBox = h('div', { class: 'msg-error', hidden: true });
    j.pagesBody = h('tbody');
    j.pagesCount = h('span', { class: 'muted' });
    j.outcomeFilter = h('select', { class: 'select-sm', 'aria-label': 'Filter by outcome', onchange: () => this.renderPages(j) }, h('option', { value: '', text: 'All outcomes' }));
    const pages = h(
      'details',
      { class: 'job-pages', open: open || null },
      h('summary', {}, 'Pages ', j.pagesCount),
      h('div', { class: 'job-pages-tools' }, j.outcomeFilter),
      h(
        'div',
        { class: 'table-wrap' },
        h('table', { class: 'data-table pages-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Outcome' }), h('th', { text: 'Status' }), h('th', { class: 'num', text: 'Depth' }), h('th', { text: 'Page' }), h('th', { text: 'Time' }))), j.pagesBody),
      ),
    );
    j.el = h(
      'article',
      { class: 'card job-card' },
      h('div', { class: 'job-head' }, h('div', { class: 'job-head-main' }, j.title, j.sub), h('div', { class: 'job-head-actions' }, j.stateChip, j.cancelBtn)),
      h('div', { class: 'progress' }, j.bar),
      j.progressText,
      counters,
      j.inflight,
      j.errorBox,
      pages,
    );
    const recent = Array.isArray(status.recent) ? [...status.recent] : [];
    recent.sort((a, b) => (toDate(a.ts)?.getTime() || 0) - (toDate(b.ts)?.getTime() || 0));
    for (const p of recent) this.addPage(j, p, false);
    this.renderPages(j);
    return j;
  },

  update(j, status) {
    j.status = status;
    const st = status.state || 'queued';
    j.stateChip.replaceChildren(chip(st, STATE_COLOR[st] || 'gray'));
    j.cancelBtn.hidden = !this.isActive(status);
    const seeds = Array.isArray(status.seeds) ? status.seeds : [];
    j.title.replaceChildren(h('span', { class: 'mono job-id', text: status.id }), roleChip(status.role), h('span', { class: 'job-seeds', text: seeds.length ? truncate(seeds.join(', '), 90) : '' }));
    const started = toDate(status.startedAt);
    const finished = toDate(status.finishedAt);
    const elapsed = started ? (finished || new Date()).getTime() - started.getTime() : null;
    j.sub.textContent = [started ? `Started ${fmtDateTime(started)}` : 'Not started', elapsed !== null ? `${finished ? 'took' : 'running'} ${fmtMs(elapsed)}` : ''].filter(Boolean).join(' · ');
    const c = status.counts || {};
    for (const [key] of COUNTERS) {
      const { cell, v } = j.counterEls[key];
      const val = c[key] || 0;
      v.textContent = fmtNum(val);
      cell.classList.toggle('zero', !val);
      // Hide the counter that does not apply to this role.
      if (key === 'indexed') cell.hidden = status.role === 'corpus' && !val;
      if (key === 'collected') cell.hidden = status.role !== 'corpus' && !val;
    }
    const max = (status.options && status.options.maxPages) || null;
    const done = !this.isActive(status);
    const pct = done ? 100 : max ? Math.min(100, ((c.fetched || 0) / max) * 100) : 0;
    j.bar.style.width = `${pct}%`;
    j.bar.className = `progress-bar ${done ? `done-${st}` : 'running'}`;
    j.progressText.textContent = max ? `${fmtNum(c.fetched || 0)} of max ${fmtNum(max)} pages fetched` : `${fmtNum(c.fetched || 0)} pages fetched`;
    const inflight = Array.isArray(status.inFlight) ? status.inFlight : [];
    j.inflight.replaceChildren(...(inflight.length && !done ? [h('span', { class: 'muted', text: 'In flight: ' }), ...inflight.slice(0, 4).map((u) => h('span', { class: 'mono inflight-url', text: truncate(u, 70), title: u }))] : []));
    j.errorBox.hidden = !status.error;
    j.errorBox.textContent = status.error ? String(status.error) : '';
    const recent = Array.isArray(status.recent) ? status.recent : [];
    let added = false;
    for (const p of recent) added = this.addPage(j, p, false) || added;
    if (added) this.renderPages(j);
  },

  addPage(j, p, render = true) {
    if (!p || !p.url) return false;
    const key = `${p.url}|${p.outcome}`;
    if (j.pageKeys.has(key)) return false;
    j.pageKeys.add(key);
    j.pages.unshift({ ...p, ts: p.ts || new Date().toISOString() });
    if (j.pages.length > 1000) j.pages.length = 1000;
    if (render) this.renderPages(j);
    return true;
  },

  renderPages(j) {
    const outcomes = [...new Set(j.pages.map((p) => p.outcome))].sort();
    const sel = j.outcomeFilter;
    const current = sel.value;
    const have = new Set([...sel.options].map((o) => o.value));
    for (const o of outcomes) if (!have.has(o)) sel.append(h('option', { value: o, text: o }));
    sel.value = current;
    const rows = j.pages.filter((p) => !current || p.outcome === current).slice(0, 300);
    j.pagesCount.textContent = `(${fmtNum(j.pages.length)})`;
    j.pagesBody.replaceChildren(
      ...(rows.length
        ? rows.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, chip(p.outcome || 'unknown', outcomeColor(p.outcome))),
              h('td', {}, p.status ? chip(String(p.status), statusColor(p.status)) : h('span', { class: 'muted', text: '—' })),
              h('td', { class: 'num', text: p.depth ?? '—' }),
              h('td', { class: 'page-cell' }, p.title ? h('div', { class: 'page-title', text: truncate(p.title, 90) }) : null, extLink(p.url, truncate(p.url, 110), 'mono page-url')),
              h('td', { class: 'muted nowrap', text: fmtTime(p.ts) }),
            ),
          )
        : [h('tr', {}, h('td', { colspan: '5', class: 'muted center', text: 'No pages yet.' }))]),
    );
  },

  ensureStreams() {
    if (!this.active) return;
    let open = [...this.jobs.values()].filter((j) => j.es).length;
    for (const j of this.jobs.values()) {
      if (open >= MAX_STREAMS) break;
      if (!j.es && !j.streamFailed && this.isActive(j.status)) {
        this.openStream(j);
        open++;
      }
    }
  },

  openStream(j) {
    const es = new EventSource(`/api/crawl/${encodeURIComponent(j.id)}/events`);
    j.es = es;
    es.addEventListener('page', (e) => {
      const d = parseData(e);
      if (this.addPage(j, d)) this.scheduleRefresh(j);
    });
    const onStatus = (e) => {
      const d = parseData(e);
      const status = d && d.job && d.job.id ? d.job : d;
      if (status && status.id) this.update(j, status);
      return status;
    };
    es.addEventListener('state', onStatus);
    es.addEventListener('done', (e) => {
      const status = onStatus(e);
      this.closeStream(j);
      if (status && status.state && status.state !== 'running') toast(`Crawl ${j.id} ${status.state}`, status.state === 'done' ? 'success' : 'info', 3500);
      this.refreshJob(j);
      this.ensureStreams();
    });
    es.addEventListener('error', () => {
      // Fall back to polling for this job rather than letting it reconnect forever.
      this.closeStream(j);
      j.streamFailed = true;
      this.ensureStreams();
    });
  },

  closeStream(j) {
    if (j.es) {
      j.es.close();
      j.es = null;
    }
  },

  // Counters arrive via 'state' events; page events trigger a throttled status refresh too.
  scheduleRefresh(j) {
    if (j.refreshPending) return;
    j.refreshPending = true;
    setTimeout(() => {
      j.refreshPending = false;
      this.refreshJob(j);
    }, 1200);
  },

  async refreshJob(j) {
    try {
      const data = await api(`/api/crawl/${encodeURIComponent(j.id)}`);
      const status = data && data.job && data.job.id ? data.job : data;
      if (status && status.id) this.update(j, status);
    } catch (err) {
      if (err.status === 404) {
        this.closeStream(j);
        j.el.remove();
        this.jobs.delete(j.id);
        this.renderEmpty();
      }
    }
  },

  pollUnstreamed() {
    for (const j of this.jobs.values()) if (!j.es && this.isActive(j.status)) this.refreshJob(j);
    this.ensureStreams();
  },

  async cancel(j) {
    j.cancelBtn.disabled = true;
    try {
      const data = await api(`/api/crawl/${encodeURIComponent(j.id)}/cancel`, { method: 'POST', body: {} });
      const status = data && data.job && data.job.id ? data.job : data;
      if (status && status.id) this.update(j, status);
      else this.refreshJob(j);
      toast(`Cancelling ${j.id}`, 'info', 2500);
    } catch (err) {
      reportError(err, 'Cancel failed');
    } finally {
      j.cancelBtn.disabled = false;
    }
  },
};

/* ------------------------------------------------------------------- INDEX */

const indexView = {
  site: '',
  offset: 0,
  limit: 25,
  query: '',
  stats: null,

  init() {
    $('#index-search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.query = $('#index-q').value.trim();
      this.offset = 0;
      this.refresh();
    });
    $('#index-q').addEventListener('search', () => {
      if (!$('#index-q').value.trim() && this.query) {
        this.query = '';
        this.offset = 0;
        this.refresh();
      }
    });
    $('#index-refresh').addEventListener('click', () => this.refresh());
    $('#index-clear').addEventListener('click', () => this.clearAll());
  },

  enter() {
    this.refresh();
  },

  async refresh() {
    await this.loadOverview();
    if (this.query) await this.search();
  },

  async loadOverview() {
    try {
      const data = await api('/api/index', { query: { site: this.site, limit: this.limit, offset: this.offset } });
      this.stats = (data && data.stats) || {};
      this.renderStats(this.stats);
      this.renderSites(this.stats.sites || []);
      if (!this.query) this.renderList(data || {});
    } catch (err) {
      reportError(err, 'Could not load the index');
    }
  },

  renderStats(s) {
    const tiles = [
      ['Documents', fmtNum(s.docs ?? 0)],
      ['Passages', fmtNum(s.passages ?? 0)],
      ['Terms', fmtNum(s.terms ?? 0)],
      ['Sites', fmtNum(Array.isArray(s.sites) ? s.sites.length : 0)],
      ['Last updated', s.lastUpdated ? fmtRelative(s.lastUpdated) : '—'],
    ];
    $('#index-stats').replaceChildren(...tiles.map(([label, value]) => h('div', { class: 'stat' }, h('span', { class: 'stat-value', text: value }), h('span', { class: 'stat-label', text: label }))));
  },

  renderSites(sites) {
    const list = $('#index-sites');
    const sorted = [...sites].sort((a, b) => (b.docs || 0) - (a.docs || 0));
    const max = Math.max(1, ...sorted.map((s) => s.docs || 0));
    const total = sorted.reduce((n, s) => n + (s.docs || 0), 0);
    const item = (site, label, docs) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: `site-item${this.site === site ? ' active' : ''}`,
            onclick: () => {
              this.site = site;
              this.offset = 0;
              this.refresh();
            },
          },
          h('span', { class: 'site-name', text: label }),
          h('span', { class: 'site-count', text: fmtNum(docs) }),
          site ? h('span', { class: 'site-bar', style: { width: `${Math.max(4, ((docs || 0) / max) * 100)}%` } }) : null,
        ),
      );
    if (!sorted.length) {
      list.replaceChildren(h('li', { class: 'muted', text: 'No sites indexed yet.' }));
      return;
    }
    list.replaceChildren(item('', 'All sites', total), ...sorted.map((s) => item(s.site, s.site, s.docs || 0)));
  },

  renderList(data) {
    const docs = Array.isArray(data.docs) ? data.docs : [];
    const total = typeof data.total === 'number' ? data.total : docs.length;
    $('#index-meta').replaceChildren(
      h('span', { text: `${fmtNum(total)} document${total === 1 ? '' : 's'}${this.site ? ` on ${this.site}` : ''}` }),
      this.site ? h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Show all sites', onclick: () => ((this.site = ''), (this.offset = 0), this.refresh()) }) : null,
    );
    const box = $('#index-results');
    if (!docs.length) {
      box.replaceChildren(emptyState(total ? 'No documents on this page.' : 'The index is empty. Start a crawl with the CairnSearch role to add pages.'));
    } else {
      box.replaceChildren(
        ...docs.map((d) =>
          this.resultCard(d, [], [d.site ? chip(d.site, 'gray') : null, roleChip(d.role), typeof d.wordCount === 'number' ? h('span', { text: `${fmtNum(d.wordCount)} words` }) : null, h('span', { text: fmtRelative(d.fetchedAt), title: fmtDateTime(d.fetchedAt) })]),
        ),
      );
    }
    this.renderPager(total);
  },

  renderPager(total) {
    const pager = $('#index-pager');
    if (this.query || total <= this.limit) {
      pager.replaceChildren();
      return;
    }
    const page = Math.floor(this.offset / this.limit) + 1;
    const pages = Math.ceil(total / this.limit);
    pager.replaceChildren(
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: '← Prev', disabled: this.offset === 0 || null, onclick: () => ((this.offset = Math.max(0, this.offset - this.limit)), this.loadOverview()) }),
      h('span', { class: 'muted', text: `Page ${page} of ${pages}` }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Next →', disabled: page >= pages || null, onclick: () => ((this.offset += this.limit), this.loadOverview()) }),
    );
  },

  resultCard(d, stems, metaBits, snippet) {
    return h(
      'article',
      { class: 'result' },
      h(
        'div',
        { class: 'result-main' },
        h('button', { type: 'button', class: 'result-title', onclick: () => this.openDoc(d.url) }, highlight(d.title || d.url, stems)),
        extLink(d.url, truncate(d.url, 120), 'result-url mono'),
        snippet !== undefined ? h('p', { class: 'result-snippet' }, snippet ? highlight(snippet, stems) : h('span', { class: 'muted', text: '(no snippet: page is nosnippet or has no text)' })) : null,
        h('div', { class: 'result-meta-line' }, ...metaBits.filter(Boolean)),
      ),
      h(
        'div',
        { class: 'result-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'View', onclick: () => this.openDoc(d.url) }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm danger-text', text: 'Delete', onclick: () => this.deleteDoc(d.url) }),
      ),
    );
  },

  async search() {
    const box = $('#index-results');
    box.replaceChildren(loading('Searching…'));
    try {
      const data = await api('/api/search', { query: { q: this.query, limit: 30, site: this.site } });
      const results = (data && data.results) || [];
      const stems = queryStems(this.query);
      $('#index-meta').replaceChildren(
        h('span', { text: `${fmtNum(data.total ?? results.length)} result${(data.total ?? results.length) === 1 ? '' : 's'} for “${this.query}”${this.site ? ` on ${this.site}` : ''}` }),
        typeof data.tookMs === 'number' ? h('span', { class: 'muted', text: ` · ${data.tookMs.toFixed ? data.tookMs.toFixed(1) : data.tookMs} ms` }) : null,
        h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Clear search', onclick: () => ((this.query = ''), ($('#index-q').value = ''), this.refresh()) }),
      );
      box.replaceChildren(
        ...(results.length
          ? results.map((r) =>
              this.resultCard(
                r,
                stems,
                [r.site ? chip(r.site, 'gray') : null, typeof r.score === 'number' ? h('span', { text: `score ${r.score.toFixed(2)}` }) : null, r.fetchedAt ? h('span', { text: fmtRelative(r.fetchedAt), title: fmtDateTime(r.fetchedAt) }) : null],
                r.snippet || '',
              ),
            )
          : [emptyState('No matching documents.')]),
      );
      $('#index-pager').replaceChildren();
    } catch (err) {
      box.replaceChildren(emptyState('Search failed.'));
      reportError(err, 'Search failed');
    }
  },

  async openDoc(url) {
    drawer.open('Document', loading());
    try {
      const data = await api('/api/index/doc', { query: { url } });
      const doc = data && data.doc && typeof data.doc === 'object' ? data.doc : data;
      if (!doc || !doc.url) throw new Error('Document not found');
      drawer.open(doc.title || doc.url, this.docView(doc));
    } catch (err) {
      drawer.close();
      reportError(err, 'Could not open document');
    }
  },

  docView(doc) {
    const withheld = doc.contentWithheld
      ? h('p', {
          class: 'muted',
          text:
            doc.contentWithheld === 'noarchive'
              ? 'This page is noarchive: its owner asked that no cached copy be shown, so the stored text is not displayed.'
              : 'This page is nosnippet: its owner asked that no text excerpt be shown, so the stored text is not displayed.',
        })
      : null;
    const panes = {
      rendered: () => h('div', { class: 'md doc-md' }, renderMarkdown(doc.markdown || doc.text || '', { headingOffset: 1 })),
      markdown: () => h('pre', { class: 'code-block wrap', text: doc.markdown || '(no markdown stored)' }),
      text: () => h('pre', { class: 'code-block wrap', text: doc.text || '(no text stored)' }),
    };
    const body = h('div', { class: 'tab-body' });
    const tabs = tabBar(
      [
        ['rendered', 'Rendered'],
        ['markdown', 'Markdown'],
        ['text', 'Plain text'],
      ],
      (key) => body.replaceChildren(panes[key]()),
    );
    body.replaceChildren(panes.rendered());
    const flags = [doc.noarchive ? chip('noarchive', 'amber') : null, doc.nosnippet ? chip('nosnippet', 'amber') : null];
    const headings = Array.isArray(doc.headings) ? doc.headings : [];
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'drawer-actions' },
        extLink(doc.url, 'Open page ↗', 'btn btn-secondary btn-sm'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Inspect fetch', onclick: () => (drawer.close(), go('fetch', { url: doc.url })) }),
        h('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Delete from index', onclick: () => this.deleteDoc(doc.url, true) }),
      ),
      kv([
        ['URL', extLink(doc.url, doc.url, 'mono break')],
        ['Site', doc.site || null],
        ['Role', roleChip(doc.role)],
        ['Fetched', doc.fetchedAt ? fmtDateTime(doc.fetchedAt) : null],
        ['Language', doc.lang || null],
        ['Canonical', doc.canonical ? extLink(doc.canonical, doc.canonical, 'mono break') : null],
        ['Description', doc.description || null],
        ['Content hash', doc.contentHash ? code(doc.contentHash, 'break') : null],
        ['Flags', flags.some(Boolean) ? h('span', { class: 'chips' }, flags) : null],
      ]),
      headings.length
        ? h('details', { class: 'outline' }, h('summary', { text: `Outline (${headings.length} headings)` }), h('ul', {}, headings.slice(0, 80).map((hd) => h('li', { class: `outline-h${hd.level || 2}`, text: hd.text }))))
        : null,
      withheld,
      withheld ? null : tabs,
      withheld ? null : body,
    );
  },

  async deleteDoc(url, fromDrawer = false) {
    if (!window.confirm(`Remove this document from the index?\n\n${url}`)) return;
    try {
      await api('/api/index/doc', { method: 'DELETE', query: { url } });
      toast('Document removed from the index', 'success', 2500);
      if (fromDrawer) drawer.close();
      this.refresh();
    } catch (err) {
      reportError(err, 'Delete failed');
    }
  },

  async clearAll() {
    if (!window.confirm('Clear the entire search index? This cannot be undone.')) return;
    try {
      await api('/api/index/clear', { method: 'POST', body: {} });
      toast('Index cleared', 'success');
      this.site = '';
      this.offset = 0;
      this.query = '';
      $('#index-q').value = '';
      this.refresh();
    } catch (err) {
      reportError(err, 'Clear failed');
    }
  },
};

function tabBar(items, onSelect) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  items.forEach(([key, label], idx) => {
    const b = h('button', {
      type: 'button',
      role: 'tab',
      class: `tab${idx === 0 ? ' active' : ''}`,
      'aria-selected': String(idx === 0),
      text: label,
      onclick: () => {
        $$('.tab', bar).forEach((t) => {
          t.classList.toggle('active', t === b);
          t.setAttribute('aria-selected', String(t === b));
        });
        onSelect(key);
      },
    });
    bar.append(b);
  });
  return bar;
}

/* ------------------------------------------------------------------- FETCH */

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/xml;q=0.8,*/*;q=0.5';

const fetchView = {
  busy: false,

  init() {
    $('#fetch-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.run();
    });
  },

  enter(params) {
    if (params && params.url) {
      $('#fetch-url').value = params.url;
      if (params.role) $('#fetch-role').value = params.role;
      this.run();
    } else setTimeout(() => $('#fetch-url').focus(), 0);
  },

  async run() {
    if (this.busy) return;
    const url = $('#fetch-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('Enter an http(s) URL', 'error');
    const role = $('#fetch-role').value;
    const index = $('#fetch-index').checked;
    const out = $('#fetch-out');
    out.replaceChildren(loading(`Fetching as ${ROLE_LABEL[role]}… (politeness delays apply)`));
    this.busy = true;
    $('#fetch-submit').disabled = true;
    try {
      const [fetched, signed, identity] = await Promise.allSettled([
        api('/api/fetch', { method: 'POST', body: { url, role, index } }),
        api('/api/sign-preview', { method: 'POST', body: { url, role } }),
        loadIdentity(),
      ]);
      if (fetched.status === 'rejected') throw fetched.reason;
      this.render(fetched.value || {}, signed.status === 'fulfilled' ? signed.value : null, identity.status === 'fulfilled' ? identity.value : null, role, signed.status === 'rejected' ? signed.reason : null);
    } catch (err) {
      out.replaceChildren(h('div', { class: 'card msg-error', text: `Fetch failed: ${err.message}` }));
      reportError(err, 'Fetch failed');
    } finally {
      this.busy = false;
      $('#fetch-submit').disabled = false;
    }
  },

  requestHeaders(result, signPreview, identity, role) {
    const headers = {};
    const roleInfo = identity && Array.isArray(identity.roles) ? identity.roles.find((r) => r.id === role) : null;
    headers['User-Agent'] = result.userAgent || (roleInfo && roleInfo.userAgent) || '(unknown)';
    headers.Accept = DEFAULT_ACCEPT;
    headers['Accept-Language'] = 'en';
    if (identity && identity.contact) headers.From = identity.contact;
    const sig = signPreview && signPreview.headers && typeof signPreview.headers === 'object' ? signPreview.headers : signPreview;
    if (sig && typeof sig === 'object') {
      for (const [k, v] of Object.entries(sig)) {
        if (typeof v !== 'string') continue;
        // Normalise header-name casing so preview duplicates replace defaults.
        const existing = Object.keys(headers).find((x) => x.toLowerCase() === k.toLowerCase());
        if (existing) delete headers[existing];
        headers[k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())] = v;
      }
    }
    return headers;
  },

  render(data, signPreview, identity, role, signError) {
    const out = $('#fetch-out');
    const r = data.result || {};
    const ex = data.extracted || null;
    const rb = data.robots || null;
    const blocked = r.blocked || null;

    // Summary
    const status = r.status;
    const headline = blocked
      ? h('span', { class: 'big-status red', text: blocked.reason === 'robots' ? 'Blocked by robots.txt' : `Blocked: ${blocked.reason}` })
      : r.error
        ? h('span', { class: 'big-status red', text: 'Request failed' })
        : h('span', { class: `big-status ${statusColor(status)}`, text: status ? `HTTP ${status}` : 'No response' });
    const summaryChips = [
      roleChip(r.role || role),
      r.signed ? chip('signed', 'teal', 'Request carried Web Bot Auth signature headers') : chip('unsigned', 'gray'),
      r.truncated ? chip('truncated', 'amber', 'Body exceeded maxBytes') : null,
      data.indexed ? chip(`index: ${data.indexed}`, outcomeColor(data.indexed)) : null,
      r.xRobotsTag && Object.entries(r.xRobotsTag).some(([, v]) => v) ? chip(`X-Robots-Tag: ${Object.entries(r.xRobotsTag).filter(([, v]) => v).map(([k]) => k).join(', ')}`, 'purple') : null,
    ];
    const summary = h(
      'section',
      { class: 'card fetch-summary' },
      h('div', { class: 'fetch-headline' }, headline, h('span', { class: 'chips' }, summaryChips)),
      kv([
        ['Requested', extLink(r.url || $('#fetch-url').value, r.url || $('#fetch-url').value, 'mono break')],
        ['Final URL', r.finalUrl && r.finalUrl !== r.url ? extLink(r.finalUrl, r.finalUrl, 'mono break') : undefined],
        ['Content type', r.contentType || null],
        ['Size', typeof r.bytes === 'number' ? fmtBytes(r.bytes) : null],
        ['Elapsed', typeof r.elapsedMs === 'number' ? fmtMs(r.elapsedMs) : null],
        ['Blocked', blocked ? h('span', {}, h('strong', { text: blocked.reason }), blocked.detail ? ` — ${blocked.detail}` : '', blocked.rule ? h('span', {}, ' (', code(robotsRuleText(blocked.rule)), ')') : '') : undefined],
        ['Error', r.error ? h('span', { class: 'danger-text', text: r.error }) : undefined],
      ]),
    );

    // Robots decision
    const robotsCard = card(
      'robots.txt decision',
      rb && rb.allowed === null && rb.error
        ? h('p', { class: 'msg-error', text: `Robots check failed: ${rb.error}` })
        : rb
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'decision-line' },
              rb.allowed ? chip('Allowed', 'green') : chip('Disallowed', 'red'),
              h('span', { class: 'muted', text: ` for ${ROLE_LABEL[r.role || role] || role}` }),
              rb.allowed === false && role === 'user' && !blocked ? chip('fetched anyway (user fetch not enforcing robots)', 'amber') : null,
            ),
            kv([
              // When a redirect hop was blocked, this decision is for that hop's URL.
              ['Decided for', rb.url && rb.url !== r.url ? extLink(rb.url, rb.url, 'mono break') : undefined],
              ['Matched rule', robotsRuleText(rb.rule) ? code(robotsRuleText(rb.rule)) : h('span', { class: 'muted', text: rb.allowed === false ? (rb.note || 'No matching rule') : 'No matching rule (allowed by default)' })],
              ['Matched group', rb.matchedAgent ? code(`User-agent: ${rb.matchedAgent}`) : h('span', { class: 'muted', text: 'none (no group applies)' })],
              ['robots.txt', rb.robotsUrl ? extLink(rb.robotsUrl, rb.robotsUrl, 'mono break') : null],
              ['HTTP status', rb.status !== undefined && rb.status !== null ? String(rb.status) : null],
              ['Crawl-delay', rb.crawlDelay ? `${rb.crawlDelay} s` : null],
              ['Source', rb.source || null],
            ]),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Open in Robots tester', onclick: () => go('robots', { url: r.url || $('#fetch-url').value }) }),
          )
        : h('p', { class: 'muted', text: role === 'user' ? 'Robots check skipped (respect for user fetches is disabled in Settings).' : 'No robots information returned.' }),
    );

    // Request headers
    const reqHeaders = this.requestHeaders(r, signPreview, identity, role);
    const requestCard = card(
      'Request headers',
      headersTable(reqHeaders, {
        note: signError
          ? `Signature preview unavailable: ${signError.message}`
          : 'Signature headers are a fresh preview from /api/sign-preview; the real request carried its own timestamp and nonce.',
      }),
    );

    // Response
    const redirects = Array.isArray(r.redirects) ? r.redirects : [];
    const responseCard = card(
      'Response',
      redirects.length
        ? h(
            'div',
            { class: 'redirects' },
            h('h3', { class: 'sub-title', text: `Redirects (${redirects.length})` }),
            h('ol', { class: 'redirect-list' }, redirects.map((rd) => h('li', {}, chip(String(rd.status ?? ''), statusColor(rd.status)), h('span', { class: 'mono break', text: ` ${rd.from} ` }), h('span', { class: 'arrow', text: '→' }), h('span', { class: 'mono break', text: ` ${rd.to}` })))),
          )
        : null,
      r.headers && Object.keys(r.headers).length ? headersTable(r.headers) : h('p', { class: 'muted', text: 'No response headers (request was not sent or failed).' }),
    );

    const cards = [summary, h('div', { class: 'grid-2' }, robotsCard, requestCard), responseCard];

    // Extracted content
    if (ex) {
      const mr = ex.metaRobots || {};
      const mrFlags = Object.entries(mr).filter(([, v]) => v).map(([k]) => chip(k, 'purple'));
      const headings = Array.isArray(ex.headings) ? ex.headings : [];
      const mdBody = h('div', { class: 'tab-body' });
      const panes = {
        rendered: () => h('div', { class: 'md doc-md' }, renderMarkdown(ex.markdown || '', { headingOffset: 1 })),
        raw: () => h('pre', { class: 'code-block wrap', text: ex.markdown || '' }),
      };
      mdBody.replaceChildren(panes.rendered());
      cards.push(
        card(
          'Extracted content',
          kv([
            ['Title', ex.title || null],
            ['Description', ex.description || null],
            ['Words', typeof ex.wordCount === 'number' ? fmtNum(ex.wordCount) : null],
            ['Language', ex.lang ? ex.lang : undefined],
            ['Canonical', ex.canonical ? extLink(ex.canonical, ex.canonical, 'mono break') : undefined],
            ['Markdown', ex.markdownTruncated ? chip('truncated to 20k characters', 'amber') : undefined],
            ['Meta robots', mrFlags.length ? h('span', { class: 'chips' }, mrFlags) : h('span', { class: 'muted', text: 'none' })],
            ['Headings', headings.length ? String(headings.length) : null],
          ]),
          ex.markdown
            ? h(
                'div',
                {},
                tabBar(
                  [
                    ['rendered', 'Rendered'],
                    ['raw', 'Markdown'],
                  ],
                  (k) => mdBody.replaceChildren(panes[k]()),
                ),
                mdBody,
              )
            : h('p', { class: 'muted', text: 'No markdown extracted.' }),
        ),
      );
      const links = Array.isArray(ex.links) ? ex.links : [];
      if (links.length) cards.push(this.linksCard(links, role, ex.linkCount));
    }
    out.replaceChildren(...cards);
  },

  linksCard(links, role, totalCount) {
    const filter = h('input', { type: 'search', class: 'input-sm', placeholder: 'Filter links…', 'aria-label': 'Filter links' });
    const tbody = h('tbody');
    const draw = () => {
      const f = filter.value.trim().toLowerCase();
      const rows = links.filter((l) => !f || `${l.url} ${l.text}`.toLowerCase().includes(f));
      tbody.replaceChildren(
        ...rows.map((l) =>
          h(
            'tr',
            {},
            h('td', { class: 'link-text', text: truncate(l.text || '', 60) || '—' }),
            h('td', {}, extLink(l.url, truncate(l.url, 90), 'mono page-url')),
            h('td', {}, l.nofollow ? chip('nofollow', 'amber') : null, l.rel && !/^\s*$/.test(l.rel) ? h('span', { class: 'muted small', text: ` ${l.rel}` }) : null),
            h(
              'td',
              { class: 'nowrap' },
              h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Inspect', onclick: () => go('fetch', { url: l.url, role }) }),
              h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Robots', onclick: () => go('robots', { url: l.url }) }),
            ),
          ),
        ),
      );
    };
    filter.addEventListener('input', draw);
    draw();
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: typeof totalCount === 'number' && totalCount > links.length ? `Links (first ${links.length} of ${totalCount})` : `Links (${links.length})` }), filter),
      h('div', { class: 'table-wrap scroll-y' }, h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Text' }), h('th', { text: 'URL' }), h('th', { text: 'Rel' }), h('th', { text: '' }))), tbody)),
    );
  },
};

/* ------------------------------------------------------------------ ROBOTS */

const ROBOTS_EXAMPLE = `# Example: search allowed, dataset collection opted out
User-agent: *
Disallow: /private/
Disallow: /admin/

User-agent: CairnSearch
Allow: /private/public-note.html
Disallow: /private/
Disallow: /*.pdf$
Disallow: /search?

User-agent: CairnCorpus
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;

const robotsView = {
  init() {
    $('#robots-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.run();
    });
    $('#robots-example').addEventListener('click', () => {
      $('#robots-txt').value = ROBOTS_EXAMPLE;
      if (!$('#robots-url').value) $('#robots-url').value = 'https://example.com/private/secret.html';
    });
    $('#robots-cache-refresh').addEventListener('click', () => this.loadCache());
    $('#robots-cache-clear').addEventListener('click', () => this.clearCache());
  },

  enter(params) {
    this.loadCache();
    if (params && params.url) {
      $('#robots-url').value = params.url;
      $('#robots-txt').value = '';
      this.run();
    }
  },

  async run() {
    const url = $('#robots-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return toast('Enter an http(s) URL', 'error');
    const robotsTxt = $('#robots-txt').value;
    const body = { url };
    if (robotsTxt.trim()) body.robotsTxt = robotsTxt;
    const out = $('#robots-out');
    out.replaceChildren(loading(body.robotsTxt ? 'Evaluating pasted robots.txt…' : 'Fetching robots.txt…'));
    try {
      const data = await api('/api/robots/check', { method: 'POST', body });
      out.replaceChildren(this.renderResult(data || {}, Boolean(body.robotsTxt)));
      if (!body.robotsTxt) this.loadCache();
    } catch (err) {
      out.replaceChildren();
      reportError(err, 'Robots check failed');
    }
  },

  renderResult(d, pasted) {
    const decisions = Array.isArray(d.decisions) ? d.decisions : [];
    const tbody = h('tbody');
    for (const dec of decisions) {
      const rule = robotsRuleText(dec.rule);
      tbody.append(
        h(
          'tr',
          { class: dec.allowed ? 'row-allowed' : 'row-blocked' },
          h('td', {}, chip(dec.role, ROLE_COLOR[dec.role] || 'gray')),
          h('td', {}, code(dec.token || ROLE_LABEL[dec.role] || '')),
          h('td', {}, dec.allowed ? chip('Allowed', 'green') : chip('Disallowed', 'red')),
          h('td', {}, rule ? code(rule) : h('span', { class: 'muted', text: 'no matching rule' })),
          h('td', {}, dec.matchedAgent ? code(dec.matchedAgent) : h('span', { class: 'muted', text: 'none' })),
        ),
      );
    }
    const sitemaps = Array.isArray(d.sitemaps) ? d.sitemaps : [];
    return h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Decisions' }), h('span', { class: 'chips' }, chip(pasted ? 'pasted robots.txt' : d.source || 'live', pasted ? 'purple' : d.source === 'stale' ? 'amber' : 'gray'))),
      kv([
        ['URL', h('span', { class: 'mono break', text: d.url || $('#robots-url').value })],
        ['robots.txt', !pasted && d.robotsUrl ? extLink(d.robotsUrl, d.robotsUrl, 'mono break') : pasted ? 'Pasted text (evaluated locally, not fetched)' : null],
        ['Crawl-delay', d.crawlDelay ? `${d.crawlDelay} s` : null],
        ['Sitemaps', sitemaps.length ? h('ul', { class: 'plain-list' }, sitemaps.map((s) => h('li', {}, extLink(s, s, 'mono break')))) : null],
      ]),
      decisions.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Role' }), h('th', { text: 'Token' }), h('th', { text: 'Decision' }), h('th', { text: 'Matched rule' }), h('th', { text: 'Matched group' }))), tbody))
        : emptyState('No decisions returned.'),
      h('p', { class: 'table-note muted', text: 'Group selection tries the role token first, then the family token “Cairn”, then “*”. Longest matching rule wins; on a tie, Allow wins.' }),
    );
  },

  async loadCache() {
    const box = $('#robots-cache');
    try {
      const data = await api('/api/robots/cache');
      const entries = (data && data.entries) || [];
      if (!entries.length) {
        box.replaceChildren(emptyState('No robots.txt files cached yet.'));
        return;
      }
      box.replaceChildren(
        h(
          'table',
          { class: 'data-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Origin' }), h('th', { text: 'Status' }), h('th', { class: 'num', text: 'Groups' }), h('th', { class: 'num', text: 'Sitemaps' }), h('th', { text: 'Fetched' }), h('th', { text: 'Expires' }), h('th', { text: '' }))),
          h(
            'tbody',
            {},
            entries.map((e) =>
              h(
                'tr',
                {},
                h('td', {}, extLink(`${e.origin}/robots.txt`, e.origin, 'mono')),
                h('td', {}, chip(e.status === 0 ? 'network error' : String(e.status ?? '—'), statusColor(e.status))),
                h('td', { class: 'num', text: fmtNum(e.groups ?? 0) }),
                h('td', { class: 'num', text: fmtNum(Array.isArray(e.sitemaps) ? e.sitemaps.length : 0) }),
                h('td', { class: 'nowrap', text: fmtRelative(e.fetchedAt), title: fmtDateTime(e.fetchedAt) }),
                h('td', { class: 'nowrap', text: fmtDateTime(e.expiresAt) }),
                h('td', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-xs', text: 'Test', onclick: () => (($('#robots-url').value = `${e.origin}/`), ($('#robots-txt').value = ''), this.run()) })),
              ),
            ),
          ),
        ),
      );
    } catch (err) {
      box.replaceChildren(emptyState('Could not load the robots cache.'));
      if (err.status !== 404) reportError(err, 'Robots cache');
    }
  },

  async clearCache() {
    try {
      await api('/api/robots/cache/clear', { method: 'POST', body: {} });
      toast('robots.txt cache cleared', 'success', 2500);
      this.loadCache();
    } catch (err) {
      reportError(err, 'Clear failed');
    }
  },
};

/* ------------------------------------------------------------------- AUDIT */

const MAX_AUDIT_ROWS = 500;

const auditView = {
  entries: [],
  ids: new Set(),
  es: null,
  stats: null,
  pendingRender: false,

  init() {
    $('#audit-role').addEventListener('change', () => this.load());
    $('#audit-kind').addEventListener('change', () => this.load());
    $('#audit-text').addEventListener('input', () => this.render());
    $('#audit-pause').addEventListener('change', () => {
      if (!$('#audit-pause').checked) this.render();
      this.setLive(this.es ? 'live' : 'off');
    });
    $('#audit-reload').addEventListener('click', () => this.load());
    $('#audit-body').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || e.target.closest('a')) return;
      const entry = this.entries.find((x) => String(x.id) === tr.dataset.id);
      if (entry) drawer.open(`Audit entry #${entry.id}`, h('div', { class: 'stack' }, h('div', { class: 'drawer-actions' }, copyButton(() => JSON.stringify(entry, null, 2), 'Copy JSON')), jsonBlock(entry)));
    });
  },

  async enter() {
    this.openStream();
    await this.load();
  },

  leave() {
    if (this.es) this.es.close();
    this.es = null;
    this.setLive('off');
  },

  setLive(stateName) {
    const el = $('#audit-live');
    const paused = $('#audit-pause').checked;
    el.className = `live-indicator ${paused && stateName === 'live' ? 'paused' : stateName}`;
    $('.live-text', el).textContent = stateName === 'live' ? (paused ? 'Paused' : 'Live') : stateName === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  },

  filters() {
    return { role: $('#audit-role').value, kind: $('#audit-kind').value, text: $('#audit-text').value.trim().toLowerCase() };
  },

  async load() {
    const { role, kind } = this.filters();
    try {
      const data = await api('/api/audit', { query: { limit: 300, role, kind } });
      const loaded = Array.isArray(data && data.entries) ? data.entries.slice() : [];
      // Keep entries that streamed in while the request was in flight.
      const maxId = loaded.reduce((m, e) => (typeof e.id === 'number' && e.id > m ? e.id : m), -Infinity);
      const newer = this.entries.filter((e) => typeof e.id === 'number' && e.id > maxId && (!role || e.role === role) && (!kind || e.kind === kind));
      this.entries = [...newer, ...loaded];
      this.ids = new Set(this.entries.map((e) => e.id));
      this.stats = (data && data.stats) || null;
      this.renderStats();
      this.render();
    } catch (err) {
      reportError(err, 'Could not load audit log');
    }
  },

  openStream() {
    if (this.es) return;
    const es = new EventSource('/api/audit/stream');
    this.es = es;
    es.addEventListener('open', () => this.setLive('live'));
    es.addEventListener('entry', (e) => this.add(parseData(e)));
    // Audit streaming is idempotent, so the browser's automatic reconnect is fine here.
    es.addEventListener('error', () => this.setLive(es.readyState === EventSource.CLOSED ? 'off' : 'reconnecting'));
  },

  add(entry) {
    if (!entry || entry.id === undefined || this.ids.has(entry.id)) return;
    this.ids.add(entry.id);
    this.bumpStats(entry);
    const { role, kind } = this.filters();
    if ((role && entry.role !== role) || (kind && entry.kind !== kind)) return;
    this.entries.unshift(entry);
    if (this.entries.length > 2000) this.entries.length = 2000;
    if ($('#audit-pause').checked || this.pendingRender) return;
    // Batch bursts of entries into one render per frame.
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.render();
      this.renderStats();
    });
  },

  bumpStats(e) {
    if (!this.stats) return;
    const s = this.stats;
    s.total = (s.total || 0) + 1;
    s.byKind = s.byKind || {};
    s.byKind[e.kind] = (s.byKind[e.kind] || 0) + 1;
    if (e.role) {
      s.byRole = s.byRole || {};
      s.byRole[e.role] = (s.byRole[e.role] || 0) + 1;
    }
    if (e.blocked) s.blocked = (s.blocked || 0) + 1;
    if (e.error) s.errors = (s.errors || 0) + 1;
  },

  renderStats() {
    const s = this.stats || {};
    const k = s.byKind || {};
    const tiles = [
      ['Total events', s.total],
      ['Fetches', k.fetch],
      ['robots.txt', k.robots],
      ['Blocked', s.blocked],
      ['Errors', s.errors],
      ['Agent runs', k.agent],
    ];
    $('#audit-stats').replaceChildren(...tiles.map(([label, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-value', text: fmtNum(v || 0) }), h('span', { class: 'stat-label', text: label }))));
  },

  matchesText(e, text) {
    if (!text) return true;
    return [e.url, e.finalUrl, e.status, e.kind, e.role, e.token, e.jobId, e.event, e.error, e.blocked, e.model, e.detail && JSON.stringify(e.detail)].some((v) => v !== undefined && v !== null && String(v).toLowerCase().includes(text));
  },

  row(e) {
    let statusCell;
    let detail;
    if (e.kind === 'crawl') {
      statusCell = chip(e.event || 'crawl', 'gray');
      detail = h('span', {}, e.jobId ? code(e.jobId) : null, ' ', e.url ? extLink(e.url, truncate(e.url, 90), 'mono') : h('span', { class: 'muted', text: typeof e.detail === 'string' ? e.detail : e.detail ? truncate(JSON.stringify(e.detail), 90) : '' }));
    } else if (e.kind === 'agent') {
      statusCell = e.ok === false ? chip('failed', 'red') : chip('ok', 'green');
      detail = h('span', {}, `${e.mode || 'agent'} · ${e.model || 'default model'}`, fmtUsd(e.costUsd) ? ` · ${fmtUsd(e.costUsd)}` : '', typeof e.durationMs === 'number' ? ` · ${fmtMs(e.durationMs)}` : '');
    } else if (e.kind === 'fetch' || e.kind === 'robots') {
      statusCell = e.status !== null && e.status !== undefined ? chip(String(e.status), statusColor(e.status)) : e.blocked ? chip('blocked', 'red') : e.error ? chip('error', 'red') : h('span', { class: 'muted', text: '—' });
      detail = h('span', { class: 'url-cell' }, h('span', { class: 'method', text: e.method || 'GET' }), ' ', extLink(e.url, truncate(e.url, 100), 'mono'), e.finalUrl && e.finalUrl !== e.url ? h('span', { class: 'muted small', text: ` → ${truncate(e.finalUrl, 60)}` }) : null);
    } else {
      statusCell = chip(e.kind || 'event', 'gray');
      detail = h('span', { class: 'muted', text: truncate(e.message || e.detail || e.event || JSON.stringify(e), 110) });
    }
    const robots = e.robots ? chip(e.robots, e.robots === 'allowed' ? 'green' : e.robots === 'disallowed' ? 'red' : 'gray', robotsRuleText(e.rule) || undefined) : null;
    const flags = [
      e.signed ? chip('signed', 'teal') : null,
      e.blocked ? chip(`blocked: ${e.blocked}`, 'red') : null,
      e.error ? chip('error', 'red', String(e.error)) : null,
      e.attempt > 1 ? chip(`retry ${e.attempt - 1}`, 'amber') : null,
    ];
    return h(
      'tr',
      { dataset: { id: String(e.id) }, class: e.blocked || e.error ? 'row-flag' : null, title: 'Click for full entry' },
      h('td', { class: 'nowrap mono small', text: fmtTime(e.ts), title: e.ts }),
      h('td', {}, chip(e.kind || '—', e.kind === 'robots' ? 'purple' : e.kind === 'agent' ? 'teal' : e.kind === 'crawl' ? 'slate' : 'blue')),
      h('td', {}, e.role ? roleChip(e.role) : h('span', { class: 'muted', text: '—' })),
      h('td', {}, statusCell),
      h('td', { class: 'detail-cell' }, detail),
      h('td', {}, robots),
      h('td', { class: 'num', text: typeof e.bytes === 'number' ? fmtBytes(e.bytes) : '' }),
      h('td', { class: 'num', text: typeof e.elapsedMs === 'number' ? fmtNum(Math.round(e.elapsedMs)) : '' }),
      h('td', { class: 'chips' }, flags),
    );
  },

  render() {
    const { text } = this.filters();
    const rows = [];
    for (const e of this.entries) {
      if (rows.length >= MAX_AUDIT_ROWS) break;
      if (this.matchesText(e, text)) rows.push(this.row(e));
    }
    $('#audit-body').replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: '9', class: 'muted center', text: 'No audit entries match.' }))]));
    $('#audit-foot').textContent = `Showing ${fmtNum(rows.length)} of ${fmtNum(this.entries.length)} loaded entries (newest first).`;
  },
};

/* ---------------------------------------------------------------- IDENTITY */

async function loadIdentity(force = false) {
  if (!state.identity || force) state.identity = await api('/api/identity');
  return state.identity;
}

const JWKS_PATH = '/.well-known/http-message-signatures-directory';

const identityView = {
  loaded: false,

  enter() {
    if (!this.loaded) this.load();
  },

  async load() {
    const out = $('#identity-out');
    out.replaceChildren(loading());
    const [idRes, jwksRes] = await Promise.allSettled([loadIdentity(true), api(JWKS_PATH)]);
    if (idRes.status === 'rejected') {
      out.replaceChildren(emptyState('Could not load identity.'));
      reportError(idRes.reason, 'Identity');
      return;
    }
    this.loaded = true;
    const id = idRes.value || {};
    const jwks = jwksRes.status === 'fulfilled' ? jwksRes.value : null;
    const roles = Array.isArray(id.roles) ? id.roles : [];

    const overview = h(
      'section',
      { class: 'card identity-hero' },
      h('div', { class: 'identity-hero-main' }, h('h2', { class: 'card-title', text: 'Cairn bot family' }), h('p', { class: 'muted', text: 'Cairn never spoofs a browser, never rotates IPs and publishes everything a site owner needs to recognise, verify or block it.' })),
      kv([
        ['Family token', id.familyToken ? code(id.familyToken) : null],
        ['Contact', id.contact ? h('span', { text: id.contact }) : null],
        [
          'Signing key id',
          id.signingEnabled === false || !id.keyId
            ? h('span', { class: 'chips' }, chip('signing disabled', 'amber', 'Outgoing requests are not signed'), id.keyId ? h('span', { class: 'muted mono break', text: ` ${id.keyId} (inactive)` }) : null)
            : h('span', { class: 'inline-copy' }, code(id.keyId, 'break'), copyButton(id.keyId)),
        ],
        ['Key directory', extLink(JWKS_PATH, id.jwksUrl || JWKS_PATH, 'mono break')],
        ['Site-owner page', extLink('/bot', id.botPageUrl || '/bot', 'mono break')],
        ['Documentation', extLink('/docs/', '/docs/', 'mono')],
      ]),
    );

    const roleCards = h(
      'div',
      { class: 'role-grid' },
      roles.map((r) => {
        const ipFile = `/bot/${String(r.token || r.id).toLowerCase()}.json`;
        const block = `User-agent: ${r.token}\nDisallow: /`;
        return h(
          'article',
          { class: `card role-card role-${r.id}` },
          h('div', { class: 'role-head' }, h('h3', { text: r.name || r.id }), roleChip(r.id)),
          h('p', { class: 'role-purpose', text: r.purpose || '' }),
          kv([
            ['Token', code(r.token)],
            ['Trigger', r.trigger || null],
            ['robots.txt', r.respectsRobots ? chip('respected', 'green') : chip('not enforced', 'amber', 'User-triggered fetches ignore robots.txt with the current setting')],
            ['IP ranges', extLink(ipFile, ipFile, 'mono')],
          ]),
          h('div', { class: 'ua-block' }, h('div', { class: 'ua-head' }, h('span', { class: 'field-label', text: 'User-Agent' }), copyButton(r.userAgent || '')), h('code', { class: 'ua-string', text: r.userAgent || '' })),
          h('details', { class: 'advanced' }, h('summary', { text: `Block ${r.token} in robots.txt` }), h('div', { class: 'ua-block' }, h('div', { class: 'ua-head' }, h('span'), copyButton(block)), h('pre', { class: 'code-block small', text: block }))),
        );
      }),
    );

    const jwksCard = h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Web Bot Auth key directory (JWKS)' }), jwks ? copyButton(() => JSON.stringify(jwks, null, 2), 'Copy JSON') : null),
      jwks ? jsonBlock(jwks) : h('p', { class: 'muted', text: `Could not load ${JWKS_PATH}${jwksRes.reason ? `: ${jwksRes.reason.message}` : ''}` }),
    );

    out.replaceChildren(overview, roleCards, h('div', { class: 'grid-2' }, jwksCard, this.verifyCard()));
  },

  verifyCard() {
    const input = h('input', { type: 'url', value: `${location.origin}/`, 'aria-label': 'URL to sign' });
    const result = h('div', { class: 'stack-sm' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Sign & verify' });
    const form = h(
      'form',
      {
        class: 'verify-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const url = input.value.trim();
          if (!/^https?:\/\//i.test(url)) return toast('Enter an http(s) URL', 'error');
          btn.disabled = true;
          result.replaceChildren(loading('Signing…'));
          try {
            const preview = await api('/api/sign-preview', { method: 'POST', body: { url } });
            const raw = preview && preview.headers && typeof preview.headers === 'object' ? preview.headers : preview || {};
            const headers = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]));
            if (!headers.signature) {
              result.replaceChildren(h('p', { class: 'muted', text: 'No signature headers were produced (signing may be disabled in Settings).' }));
              return;
            }
            const v = await api('/api/verify-signature', { method: 'POST', body: { url, headers } });
            result.replaceChildren(
              h('div', { class: 'decision-line' }, v.valid ? chip('Signature valid', 'green') : chip('Signature invalid', 'red'), v.reason ? h('span', { class: 'muted', text: ` ${v.reason}` }) : null),
              kv([
                ['keyid', v.keyid ? code(v.keyid, 'break') : null],
                ['Signature-Agent', v.agent ? code(v.agent, 'break') : null],
              ]),
              headersTable(headers),
            );
          } catch (err) {
            result.replaceChildren();
            reportError(err, 'Signature test failed');
          } finally {
            btn.disabled = false;
          }
        },
      },
      h('div', { class: 'inline-form' }, input, btn),
    );
    return h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title', text: 'Signature self-test' }),
      h('p', { class: 'muted', text: 'Signs a request for the URL (RFC 9421, Ed25519, tag "web-bot-auth") and verifies it against the published key directory.' }),
      form,
      result,
    );
  },
};

/* ---------------------------------------------------------------- SETTINGS */

const SETTINGS_SCHEMA = [
  {
    section: 'politeness',
    title: 'Politeness',
    desc: 'How gently Cairn treats each host. A larger robots.txt Crawl-delay always wins.',
    fields: [
      { key: 'minDelayMs', label: 'Minimum delay between requests to a host', unit: 'ms', min: 0, step: 100 },
      { key: 'maxConcurrencyPerHost', label: 'Concurrent requests per host', min: 1, max: 16 },
      { key: 'globalConcurrency', label: 'Global concurrency', min: 1, max: 64 },
      { key: 'backoffBaseMs', label: 'Backoff base after 429 / 5xx', unit: 'ms', min: 0, step: 100 },
      { key: 'maxBackoffMs', label: 'Maximum backoff', unit: 'ms', min: 0, step: 1000 },
    ],
  },
  {
    section: 'robots',
    title: 'robots.txt',
    desc: 'Search and corpus crawls always obey robots.txt. This controls user-triggered fetches.',
    fields: [
      {
        key: 'respectForUserFetch',
        type: 'bool',
        label: 'Respect robots.txt for user-triggered fetches (Cairn-User)',
        help: 'Recommended. When off, Cairn-User behaves like ChatGPT-User and may fetch a page a person asked for even if automated crawlers are disallowed.',
      },
      { key: 'cacheTtlMs', label: 'robots.txt cache lifetime', unit: 'ms', min: 0, step: 60000 },
    ],
  },
  {
    section: 'agent',
    title: 'Answer agent (Claude CLI)',
    desc: 'Model and spending limits for quick answers and deep research.',
    fields: [
      { key: 'model', type: 'text', label: 'Model', list: ['haiku', 'sonnet', 'opus'], help: 'Alias or full model id passed to claude --model.' },
      { key: 'maxBudgetUsd', label: 'Budget per run', unit: 'USD', min: 0, step: 0.05 },
      { key: 'timeoutMs', label: 'Agent timeout', unit: 'ms', min: 1000, step: 1000 },
      { key: 'maxPassages', label: 'Passages per quick answer', min: 1, max: 50 },
    ],
  },
  {
    section: 'crawl',
    title: 'Crawl defaults',
    fields: [
      { key: 'maxPages', label: 'Max pages', min: 1 },
      { key: 'maxDepth', label: 'Max depth', min: 0 },
      { key: 'concurrency', label: 'Crawler concurrency', min: 1, max: 32 },
      { key: 'sameSiteOnly', type: 'bool', label: 'Stay on the seed site' },
      { key: 'useSitemaps', type: 'bool', label: 'Use sitemaps' },
    ],
  },
  {
    section: 'fetch',
    title: 'Fetcher',
    fields: [
      { key: 'timeoutMs', label: 'Request timeout', unit: 'ms', min: 1000, step: 1000 },
      { key: 'retries', label: 'Retries on 429 / 5xx / network errors', min: 0, max: 10 },
      { key: 'maxRedirects', label: 'Max redirects', min: 0, max: 20 },
      { key: 'maxBytes', label: 'Max body size', unit: 'bytes', min: 1024, step: 1024 },
      { key: 'blockPrivateNetworks', type: 'bool', label: 'Block private-network addresses' },
    ],
  },
  {
    section: 'signing',
    title: 'Web Bot Auth',
    fields: [{ key: 'enabled', type: 'bool', label: 'Sign outgoing requests (HTTP Message Signatures, Ed25519)' }],
  },
  {
    section: null,
    title: 'Operator',
    fields: [{ key: 'contact', type: 'text', label: 'Contact (sent in the From header)' }],
  },
];

const settingsView = {
  loaded: null,

  init() {
    $('#settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.save();
    });
    $('#settings-reset').addEventListener('click', () => this.loaded && this.render(this.loaded));
  },

  async enter() {
    const box = $('#settings-sections');
    box.replaceChildren(loading());
    try {
      this.render(await getConfig(true));
    } catch (err) {
      box.replaceChildren(emptyState('Could not load settings.'));
      reportError(err, 'Settings');
    }
  },

  valueOf(cfg, section, key) {
    return section ? cfg && cfg[section] && cfg[section][key] : cfg && cfg[key];
  },

  render(cfg) {
    this.loaded = JSON.parse(JSON.stringify(cfg || {}));
    const box = $('#settings-sections');
    const sections = [];
    for (const sec of SETTINGS_SCHEMA) {
      const fields = sec.fields.filter((f) => this.valueOf(cfg, sec.section, f.key) !== undefined);
      if (!fields.length) continue;
      const body = h('div', { class: 'settings-fields' });
      for (const f of fields) {
        const id = `set-${sec.section || 'root'}-${f.key}`;
        const val = this.valueOf(cfg, sec.section, f.key);
        const data = { section: sec.section || '', key: f.key, type: f.type || 'number' };
        if (f.type === 'bool') {
          body.append(
            h('label', { class: 'toggle-field', for: id }, h('input', { type: 'checkbox', id, class: 'switch', checked: Boolean(val), dataset: data }), h('span', {}, h('span', { class: 'toggle-label', text: f.label }), f.help ? h('small', { class: 'muted', text: f.help }) : null)),
          );
        } else {
          const listId = f.list ? `${id}-list` : null;
          const input = h('input', {
            id,
            type: f.type === 'text' ? 'text' : 'number',
            value: val ?? '',
            min: f.min,
            max: f.max,
            step: f.step || (f.type === 'text' ? null : 1),
            list: listId,
            dataset: data,
          });
          body.append(
            h(
              'label',
              { class: 'field', for: id },
              h('span', { class: 'field-label' }, f.label, f.unit ? h('span', { class: 'field-hint', text: f.unit }) : null),
              f.unit ? h('span', { class: 'input-unit' }, input, h('span', { class: 'unit', text: f.unit })) : input,
              f.list ? h('datalist', { id: listId }, f.list.map((o) => h('option', { value: o }))) : null,
              f.help ? h('small', { class: 'muted', text: f.help }) : null,
            ),
          );
        }
      }
      sections.push(h('section', { class: 'card settings-card' }, h('h2', { class: 'card-title', text: sec.title }), sec.desc ? h('p', { class: 'muted card-desc', text: sec.desc }) : null, body));
    }
    box.replaceChildren(...(sections.length ? sections : [emptyState('The server did not return any editable settings.')]));
  },

  collect() {
    const partial = {};
    let changed = 0;
    for (const el of $$('#settings-sections [data-key]')) {
      const { section, key, type } = el.dataset;
      let value;
      if (type === 'bool') value = el.checked;
      else if (type === 'text') value = el.value.trim();
      else {
        if (el.value === '' || !Number.isFinite(Number(el.value))) throw new Error(`“${key}” must be a number`);
        value = Number(el.value);
        if (el.min !== '' && value < Number(el.min)) throw new Error(`“${key}” must be at least ${el.min}`);
        if (el.max !== '' && value > Number(el.max)) throw new Error(`“${key}” must be at most ${el.max}`);
      }
      if (value === this.valueOf(this.loaded, section, key)) continue;
      changed++;
      if (section) (partial[section] ||= {})[key] = value;
      else partial[key] = value;
    }
    return { partial, changed };
  },

  async save() {
    let collected;
    try {
      collected = this.collect();
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!collected.changed) return toast('No changes to save', 'info', 2500);
    const btn = $('#settings-save');
    btn.disabled = true;
    try {
      const data = await api('/api/config', { method: 'POST', body: collected.partial });
      const cfg = data && data.config && typeof data.config === 'object' ? data.config : data;
      state.config = cfg;
      this.render(cfg);
      toast(`Saved ${collected.changed} setting${collected.changed === 1 ? '' : 's'}`, 'success');
      if (collected.partial.robots || collected.partial.signing || collected.partial.contact !== undefined) identityView.loaded = false;
      refreshHealth();
    } catch (err) {
      reportError(err, 'Could not save settings');
    } finally {
      btn.disabled = false;
    }
  },
};

/* ------------------------------------------------------------------ router */

const VIEWS = {
  ask: { label: 'Ask', ctl: ask },
  crawl: { label: 'Crawl', ctl: crawl },
  index: { label: 'Index', ctl: indexView },
  fetch: { label: 'Fetch inspector', ctl: fetchView },
  robots: { label: 'Robots tester', ctl: robotsView },
  audit: { label: 'Audit', ctl: auditView },
  identity: { label: 'Identity', ctl: identityView },
  settings: { label: 'Settings', ctl: settingsView },
};

let currentView = null;
const pendingParams = {};

// Navigate to a view, optionally handing it parameters (e.g. a URL to inspect).
function go(view, params) {
  if (params) pendingParams[view] = params;
  if (currentView === view) {
    const p = pendingParams[view];
    delete pendingParams[view];
    runHook(view, 'enter', p);
    window.scrollTo({ top: 0 });
  } else {
    location.hash = view;
  }
}

function runHook(view, hook, arg) {
  const ctl = VIEWS[view] && VIEWS[view].ctl;
  if (!ctl || typeof ctl[hook] !== 'function') return;
  try {
    const r = ctl[hook](arg);
    if (r && typeof r.catch === 'function') r.catch((err) => reportError(err, VIEWS[view].label));
  } catch (err) {
    reportError(err, VIEWS[view].label);
  }
}

function route() {
  const name = location.hash.replace(/^#\/?/, '').split(/[?/&]/)[0].toLowerCase();
  const view = VIEWS[name] ? name : 'ask';
  if (view === currentView) return;
  if (currentView) runHook(currentView, 'leave');
  currentView = view;
  for (const s of $$('main > .view')) s.hidden = s.dataset.view !== view;
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${VIEWS[view].label} · Cairn`;
  document.body.dataset.view = view;
  window.scrollTo({ top: 0 });
  const p = pendingParams[view];
  delete pendingParams[view];
  runHook(view, 'enter', p);
}

/* -------------------------------------------------------------------- boot */

function boot() {
  drawer.init();
  for (const { ctl } of Object.values(VIEWS)) if (typeof ctl.init === 'function') ctl.init();
  window.addEventListener('hashchange', route);
  route();
  refreshHealth();
  setInterval(refreshHealth, 30000);
  refreshAssistantBadge();
  setInterval(refreshAssistantBadge, 15000);
  window.addEventListener('beforeunload', () => {
    auditView.leave();
    crawl.leave();
    if (ask.active) ask.active.stop();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
