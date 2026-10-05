// Zero-dependency, error-tolerant HTML -> {text, markdown, links, meta} extractor.
// Two passes: a lexer that turns markup into start/end/text tokens (handling
// comments, CDATA, raw-text elements, unquoted/boolean attributes), then a
// walker that tracks a light block stack to build paragraphs and markdown.
import { normalizeUrl } from '../util/url.js';

// ---------------------------------------------------------------------------
// Entities

const LATIN1_A0 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 ' +
  'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml ' +
  'Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde ' +
  'Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ' +
  'ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide ' +
  'oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED = Object.assign(Object.create(null), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '\u{a9}', REG: '\u{ae}',
  mdash: '\u{2014}', ndash: '\u{2013}', hellip: '\u{2026}', trade: '\u{2122}', TRADE: '\u{2122}',
  lsquo: '\u{2018}', rsquo: '\u{2019}', sbquo: '\u{201a}', ldquo: '\u{201c}', rdquo: '\u{201d}', bdquo: '\u{201e}',
  lsaquo: '\u{2039}', rsaquo: '\u{203a}', bull: '\u{2022}', dagger: '\u{2020}', Dagger: '\u{2021}', permil: '\u{2030}',
  prime: '\u{2032}', Prime: '\u{2033}', euro: '\u{20ac}', ensp: '\u{2002}', emsp: '\u{2003}', thinsp: '\u{2009}',
  zwnj: '\u{200c}', zwj: '\u{200d}', lrm: '\u{200e}', rlm: '\u{200f}', hyphen: '\u{2010}', minus: '\u{2212}',
  larr: '\u{2190}', uarr: '\u{2191}', rarr: '\u{2192}', darr: '\u{2193}', harr: '\u{2194}', rArr: '\u{21d2}', lArr: '\u{21d0}',
  le: '\u{2264}', ge: '\u{2265}', ne: '\u{2260}', asymp: '\u{2248}', infin: '\u{221e}', sum: '\u{2211}', radic: '\u{221a}',
  alpha: '\u{3b1}', beta: '\u{3b2}', gamma: '\u{3b3}', delta: '\u{3b4}', epsilon: '\u{3b5}', lambda: '\u{3bb}',
  mu: '\u{3bc}', pi: '\u{3c0}', sigma: '\u{3c3}', omega: '\u{3c9}', Delta: '\u{394}', Sigma: '\u{3a3}', Omega: '\u{3a9}',
  OElig: '\u{152}', oelig: '\u{153}', Scaron: '\u{160}', scaron: '\u{161}', Yuml: '\u{178}', fnof: '\u{192}',
  circ: '\u{2c6}', tilde: '\u{2dc}', hearts: '\u{2665}', spades: '\u{2660}', clubs: '\u{2663}', diams: '\u{2666}',
  check: '\u{2713}', cross: '\u{2717}', star: '\u{2606}', starf: '\u{2605}', tab: '\t', NewLine: '\n',
});
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);
LATIN1_A0.split(' ').forEach((name, i) => {
  NAMED[name] = String.fromCharCode(0xa0 + i);
  LEGACY.add(name);
});

// Numeric references in 0x80-0x9F are interpreted as windows-1252 (HTML spec).
const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,10})|([a-zA-Z][a-zA-Z0-9]{0,31}))(;?)/g;

function fromCodePoint(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\u{fffd}';
  return String.fromCodePoint(CP1252[cp] ?? cp);
}

// Decode character references. In attribute mode, legacy semicolon-less names
// are only decoded for the core four and never before "=" (keeps "?a=1&copy=2" intact).
export function decodeEntities(input, { attribute = false } = {}) {
  const s = String(input ?? '');
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (match, hex, dec, name, semi, offset) => {
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10));
    const value = NAMED[name];
    if (value === undefined) {
      // Text mode: "&copy2024" -> "(c)2024" (longest legacy prefix, as browsers do).
      if (attribute) return match;
      for (let len = Math.min(name.length - 1, 6); len >= 2; len--) {
        const prefix = name.slice(0, len);
        if (LEGACY.has(prefix)) return NAMED[prefix] + match.slice(len + 1);
      }
      return match;
    }
    if (semi) return value;
    const next = s[offset + match.length];
    if (attribute) return ['amp', 'lt', 'gt', 'quot'].includes(name) && next !== '=' ? value : match;
    return LEGACY.has(name) ? value : match;
  });
}

// ---------------------------------------------------------------------------
// Lexer

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
// Elements whose content is not markup; we scan straight to the matching close tag.
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'iframe', 'noembed', 'noframes', 'xmp', 'textarea', 'title', 'plaintext']);
const RCDATA = new Set(['title', 'textarea']);
const rawCloseRe = new Map();

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function readStartTag(src, i) {
  const n = src.length;
  let j = i + 1;
  const nameStart = j;
  while (j < n && !isWs(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>') j++;
  const name = src.slice(nameStart, j).toLowerCase();
  const attrs = Object.create(null);
  let selfClosing = false;
  while (j < n) {
    while (j < n && isWs(src.charCodeAt(j))) j++;
    if (j >= n) break;
    const ch = src[j];
    if (ch === '>') return { token: { type: 'start', name, attrs, selfClosing }, end: j + 1 };
    if (ch === '/') {
      if (src[j + 1] === '>') {
        selfClosing = true;
        return { token: { type: 'start', name, attrs, selfClosing }, end: j + 2 };
      }
      j++;
      continue;
    }
    const aStart = j;
    j++; // first char may be anything (even "="), per the HTML tokenizer
    while (j < n && !isWs(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>' && src[j] !== '=') j++;
    const aname = src.slice(aStart, j).toLowerCase();
    while (j < n && isWs(src.charCodeAt(j))) j++;
    let value = '';
    if (src[j] === '=') {
      j++;
      while (j < n && isWs(src.charCodeAt(j))) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, j + 1);
        if (close === -1) {
          // Unterminated quote: salvage up to the next ">" instead of swallowing the document.
          const gt = src.indexOf('>', j + 1);
          value = src.slice(j + 1, gt === -1 ? n : gt);
          j = gt === -1 ? n : gt;
        } else {
          value = src.slice(j + 1, close);
          j = close + 1;
        }
      } else {
        const vStart = j;
        while (j < n && !isWs(src.charCodeAt(j)) && src[j] !== '>') j++;
        value = src.slice(vStart, j);
      }
    }
    if (!(aname in attrs)) attrs[aname] = decodeEntities(value, { attribute: true });
  }
  return null; // EOF inside a tag: the tag is dropped (HTML spec behaviour)
}

export function lexHtml(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ type: 'text', text: src.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', text: src.slice(i, lt) });
    i = lt;
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 33 /* ! */) {
      if (src.startsWith('<!--', i)) {
        if (src.startsWith('>', i + 4)) i += 5;
        else if (src.startsWith('->', i + 4)) i += 6;
        else {
          const end = src.indexOf('-->', i + 4);
          i = end === -1 ? n : end + 3;
        }
      } else if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i + 9);
        tokens.push({ type: 'text', text: src.slice(i + 9, end === -1 ? n : end), cdata: true });
        i = end === -1 ? n : end + 3;
      } else {
        const end = src.indexOf('>', i + 2); // doctype / bogus comment
        i = end === -1 ? n : end + 1;
      }
      continue;
    }
    if (c1 === 63 /* ? */) {
      const end = src.indexOf('>', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c1 === 47 /* / */) {
      if (isAlpha(src.charCodeAt(i + 2))) {
        let j = i + 2;
        while (j < n && !isWs(src.charCodeAt(j)) && src[j] !== '/' && src[j] !== '>') j++;
        tokens.push({ type: 'end', name: src.slice(i + 2, j).toLowerCase() });
        const gt = src.indexOf('>', j);
        i = gt === -1 ? n : gt + 1;
      } else {
        const gt = src.indexOf('>', i + 2);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    if (isAlpha(c1)) {
      const tag = readStartTag(src, i);
      if (!tag) break;
      const { token } = tag;
      i = tag.end;
      if (RAW_TEXT.has(token.name)) {
        let textEnd = n;
        let next = n;
        if (token.name !== 'plaintext') {
          let re = rawCloseRe.get(token.name);
          if (!re) rawCloseRe.set(token.name, (re = new RegExp(`</${token.name}(?=[\\s/>])`, 'ig')));
          re.lastIndex = i;
          const m = re.exec(src);
          if (m) {
            textEnd = m.index;
            const gt = src.indexOf('>', m.index);
            next = gt === -1 ? n : gt + 1;
          }
        }
        const raw = src.slice(i, textEnd);
        token.raw = RCDATA.has(token.name) ? decodeEntities(raw) : raw;
        i = next;
      }
      tokens.push(token);
      continue;
    }
    tokens.push({ type: 'text', text: '<' });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Walker

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
// Closes an open <p> when started (subset of the HTML spec list).
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
// Content never rendered as page text.
const SKIP = new Set(['template', 'svg', 'math', 'object', 'canvas', 'audio', 'video', 'select', 'datalist', 'map']);
const HEAD_OK = new Set(['html', 'head', 'title', 'meta', 'link', 'base', 'script', 'style', 'noscript', 'template']);
const HEADING_RE = /^h[1-6]$/;
const INLINE_FRAME = { a: 'a', b: 'b', strong: 'b', em: 'i', i: 'i', code: 'code', kbd: 'code', samp: 'code', tt: 'code' };
const BR = '\u0000'; // sentinel for <br>; NULs from the source are replaced before lexing
// Nesting caps (browsers cap DOM depth too). Past them extra opens only act as
// block boundaries, which keeps every stack scan O(cap) so hostile markup such
// as 100k nested <div>s cannot make extraction quadratic.
const MAX_BLOCK_DEPTH = 256;
const MAX_SKIP_DEPTH = 256;
const MAX_MD_NESTING = 16; // markdown quote/list indentation levels actually rendered
const LIST_TAGS = new Set(['ul', 'ol', 'menu']);
// Index-stack group for an open block element (see `open` in extractHtml).
const groupOf = (name) => (HEADING_RE.test(name) ? 'h' : LIST_TAGS.has(name) ? 'list' : name);

function collapse(s) {
  return String(s ?? '').replace(/[\s\u0000]+/g, ' ').trim();
}
function normInline(s) {
  return s.replace(/\s+/g, ' ').replace(/ ?\u0000 ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}
function escapeMd(s) {
  return s.replace(/[\\`*[\]]/g, '\\$&');
}
function mdUrl(url) {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}
function codeSpan(s) {
  const text = collapse(s);
  if (!text) return '';
  const fence = text.includes('`') ? '``' : '`';
  const pad = fence.length > 1 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
// Keep surrounding whitespace outside the markers so "**x**" stays valid markdown.
function wrapMd(m, fn) {
  const inner = m.replace(/[\s\u0000]+/g, ' ').trim();
  if (!inner) return m;
  return (/^[\s\u0000]/.test(m) ? ' ' : '') + fn(inner) + (/[\s\u0000]$/.test(m) ? ' ' : '');
}

export function parseRobotsDirectives(content, target = { noindex: false, nofollow: false, noarchive: false, nosnippet: false }) {
  const parts = String(content ?? '').toLowerCase().replace(/\s*:\s*/g, ':').split(/[,\s]+/);
  for (const p of parts) {
    if (p === 'noindex') target.noindex = true;
    else if (p === 'nofollow') target.nofollow = true;
    else if (p === 'none') target.noindex = target.nofollow = true;
    else if (p === 'noarchive' || p === 'nocache') target.noarchive = true;
    else if (p === 'nosnippet' || p === 'max-snippet:0') target.nosnippet = true;
  }
  return target;
}

function resolveBase(tokens, baseUrl) {
  const pageBase = baseUrl ? normalizeUrl(String(baseUrl)) : null;
  for (const t of tokens) {
    if (t.type === 'start' && t.name === 'base' && t.attrs.href) {
      try {
        const u = pageBase ? new URL(t.attrs.href.trim(), pageBase) : new URL(t.attrs.href.trim());
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
      } catch {
        /* invalid base href: ignore */
      }
      break; // only the first <base href> counts
    }
  }
  return pageBase;
}

export function extractHtml(html, baseUrl, { botTokens = [] } = {}) {
  const src = String(html ?? '').replace(/^\u{feff}/u, '').replace(/\u0000/g, '\u{fffd}');
  const tokens = lexHtml(src);
  const base = resolveBase(tokens, baseUrl);
  const robotsNames = new Set(['robots', ...(botTokens || []).map((t) => String(t).toLowerCase())]);

  const metaRobots = { noindex: false, nofollow: false, noarchive: false, nosnippet: false };
  let title = '';
  let ogTitle = '';
  let description = '';
  let ogDescription = '';
  let lang = '';
  let metaLang = '';
  let canonical = null;
  const headings = [];
  const links = new Map(); // url -> {url, text, rel, nofollow}
  const blocks = []; // {kind, t, m}

  let pieces = []; // inline content of the current block: {t: plain, m: markdown}
  let frames = []; // open inline formatting/link frames
  const stack = []; // open block elements: {name, n?, marker?, used?}
  // group -> ascending stack indices of open elements in that group ('h' = any
  // heading, 'list' = ul/ol/menu, otherwise the tag name). Keeps "innermost
  // open X" lookups O(1) instead of scanning the whole stack.
  const open = new Map();
  const ignoredInline = { b: 0, i: 0, code: 0 }; // nested duplicate formatting opens
  const skipStack = [];
  let inHead = false;
  let inPre = false;
  let preText = '';

  const resolve = (href) => (href ? normalizeUrl(href.trim(), base || undefined) : null);

  function recordLink(url, text, rel) {
    const relNorm = collapse(rel).toLowerCase();
    const nofollow = relNorm.split(' ').includes('nofollow');
    let entry = links.get(url);
    if (!entry) {
      entry = { url, text: collapse(text), rel: relNorm, nofollow };
      links.set(url, entry);
    } else {
      if (!entry.text && text) entry.text = collapse(text);
      // Any followable occurrence makes the URL followable.
      if (entry.nofollow && !nofollow) Object.assign(entry, { nofollow: false, rel: relNorm });
    }
    return entry;
  }

  function finalizeSegment(f) {
    if (f.inPre) return;
    const seg = pieces.splice(f.start);
    let t = seg.map((p) => p.t).join('');
    let m = seg.map((p) => p.m).join('');
    if (f.tag === 'a') {
      if (!collapse(t) && f.alt) {
        t = ` ${f.alt} `;
        m = ` ${escapeMd(f.alt)} `;
      }
      if (f.entry && !f.entry.text && collapse(t)) f.entry.text = collapse(t);
      if (f.entry) m = wrapMd(m, (s) => `[${s}](${mdUrl(f.entry.url)})`);
    } else if (f.tag === 'b') m = wrapMd(m, (s) => `**${s}**`);
    else if (f.tag === 'i') m = wrapMd(m, (s) => `*${s}*`);
    else if (f.tag === 'code') m = wrapMd(t, () => codeSpan(t));
    if (t || m) pieces.push({ t, m });
    f.start = pieces.length;
  }

  function closeFrameAt(idx) {
    for (let k = frames.length - 1; k >= idx; k--) {
      const f = frames[k];
      if (f.inPre && f.entry && !f.entry.text) f.entry.text = collapse(preText.slice(f.preStart));
      finalizeSegment(f);
      if (f.tag in ignoredInline) ignoredInline[f.tag] = 0;
    }
    frames.length = idx;
  }

  const lastOf = (group) => {
    const arr = open.get(group);
    return arr && arr.length ? arr[arr.length - 1] : -1;
  };

  function pushBlock(entry) {
    const g = groupOf(entry.name);
    let arr = open.get(g);
    if (!arr) open.set(g, (arr = []));
    arr.push(stack.length);
    stack.push(entry);
  }

  // Innermost open list element with exactly this tag name (the 'list' group mixes ul/ol/menu).
  function lastOfName(name) {
    const arr = open.get('list') || [];
    for (let k = arr.length - 1; k >= 0; k--) if (stack[arr[k]].name === name) return arr[k];
    return -1;
  }

  function popBlock() {
    const e = stack.pop();
    open.get(groupOf(e.name)).pop();
    return e;
  }

  function context() {
    const k = Math.max(lastOf('h'), lastOf('li'));
    const listIdx = open.get('list') || [];
    return {
      kind: k >= 0 ? stack[k] : null,
      quote: (open.get('blockquote') || []).length,
      lists: listIdx.length,
      outerList: listIdx.length ? stack[listIdx[0]] : null,
    };
  }

  function emit(kind, t, m, quote, list = null) {
    if (quote) m = m.split('\n').map((line) => `${'>'.repeat(Math.min(quote, MAX_MD_NESTING))} ${line}`).join('\n');
    blocks.push({ kind, t, m, list });
  }

  function flush() {
    for (let k = frames.length - 1; k >= 0; k--) finalizeSegment(frames[k]);
    const t = normInline(pieces.map((p) => p.t).join(''));
    const m = normInline(pieces.map((p) => p.m).join(''));
    pieces = [];
    for (const f of frames) f.start = 0;
    if (!t) return;
    const { kind, quote, lists, outerList } = context();
    if (kind && kind.name !== 'li') {
      const level = Number(kind.name[1]);
      headings.push({ level, text: t.replace(/\n/g, ' ') });
      emit('h', t.replace(/\n/g, ' '), `${'#'.repeat(level)} ${m.replace(/\n/g, ' ')}`, quote);
    } else if (kind) {
      const indent = '  '.repeat(Math.min(MAX_MD_NESTING, Math.max(0, lists - 1)));
      const body = m.replace(/\n/g, `\n${indent}  `);
      emit('li', t, kind.used ? `${indent}  ${body}` : `${indent}${kind.marker} ${body}`, quote, outerList);
      kind.used = true;
    } else {
      emit('p', t, m, quote);
    }
  }

  function closeBlocksTo(len) {
    if (len >= stack.length) return;
    flush();
    while (stack.length > len) {
      const e = popBlock();
      if (e.name === 'pre') {
        inPre = false;
        const code = preText.replace(/^\r?\n/, '').replace(/\s+$/, '');
        preText = '';
        if (code.trim()) {
          const fence = code.includes('```') ? '~~~' : '```';
          emit('pre', code, `${fence}\n${code}\n${fence}`, context().quote);
        }
      }
    }
    const keep = frames.findIndex((f) => f.depth > len);
    if (keep !== -1) closeFrameAt(keep);
  }

  function openBlock(name, attrs) {
    const top = stack.length ? stack[stack.length - 1].name : null;
    if (top === 'p' && P_CLOSERS.has(name)) closeBlocksTo(stack.length - 1);
    if (HEADING_RE.test(name)) {
      const t2 = stack.length ? stack[stack.length - 1].name : null;
      if (t2 && HEADING_RE.test(t2)) closeBlocksTo(stack.length - 1);
    } else if (name === 'li') {
      const li = lastOf('li');
      if (li > lastOf('list')) closeBlocksTo(li);
    } else if (name === 'dt' || name === 'dd') {
      const d = Math.max(lastOf('dt'), lastOf('dd'));
      if (d > lastOf('dl')) closeBlocksTo(d);
    } else if (name === 'tr') {
      const tr = lastOf('tr');
      if (tr > lastOf('table')) closeBlocksTo(tr);
    }
    flush();
    if (name === 'hr') return;
    if (stack.length >= MAX_BLOCK_DEPTH) return; // too deep: boundary only
    const entry = { name };
    if (name === 'ol') entry.n = Number.parseInt(attrs.start, 10) - 1 || 0;
    if (name === 'li') {
      const listIdx = lastOf('list');
      const list = listIdx >= 0 ? stack[listIdx] : null;
      entry.marker = list && list.name === 'ol' ? `${++list.n}.` : '-';
      entry.used = false;
    }
    if (name === 'pre') {
      inPre = true;
      preText = '';
    }
    pushBlock(entry);
  }

  function closeBlock(name) {
    const idx = HEADING_RE.test(name) ? lastOf('h') : LIST_TAGS.has(name) ? lastOfName(name) : lastOf(name);
    if (idx >= 0) closeBlocksTo(idx);
    else flush(); // stray end tag still acts as a boundary
  }

  function handleMeta(attrs) {
    const name = (attrs.name || '').trim().toLowerCase();
    const prop = (attrs.property || '').trim().toLowerCase();
    const content = attrs.content ?? '';
    if (name === 'description' && !description) description = collapse(content);
    if (prop === 'og:description' && !ogDescription) ogDescription = collapse(content);
    if (prop === 'og:title' && !ogTitle) ogTitle = collapse(content);
    if (robotsNames.has(name)) parseRobotsDirectives(content, metaRobots);
    if ((attrs['http-equiv'] || '').toLowerCase() === 'content-language' && !metaLang) {
      metaLang = content.split(',')[0].trim();
    }
  }

  for (const tok of tokens) {
    if (tok.type === 'text') {
      if (skipStack.length) continue;
      const text = tok.cdata ? tok.text : decodeEntities(tok.text);
      if (inHead) {
        if (!/\S/.test(text)) continue;
        inHead = false; // stray text implies <body>
      }
      if (inPre) preText += text;
      else pieces.push({ t: text, m: escapeMd(text) });
      continue;
    }

    const { name } = tok;
    if (tok.type === 'end') {
      if (skipStack.length) {
        const idx = skipStack.lastIndexOf(name);
        if (idx >= 0) skipStack.length = idx;
        continue;
      }
      if (name === 'head') {
        inHead = false;
        continue;
      }
      if (name === 'br') {
        if (inPre) preText += '\n';
        else pieces.push({ t: BR, m: BR });
        continue;
      }
      const frameTag = INLINE_FRAME[name];
      if (frameTag) {
        if (ignoredInline[frameTag] > 0) {
          ignoredInline[frameTag]--;
          continue;
        }
        let idx = -1;
        for (let k = frames.length - 1; k >= 0; k--) if (frames[k].tag === frameTag) { idx = k; break; }
        if (idx >= 0) closeFrameAt(idx);
        continue;
      }
      if (inPre && name !== 'pre') continue;
      if (BLOCK.has(name)) closeBlock(name);
      else if (name === 'td' || name === 'th') pieces.push({ t: ' ', m: ' ' });
      continue;
    }

    // start tag
    const { attrs } = tok;
    if (skipStack.length) {
      if (!VOID.has(name) && !tok.selfClosing && tok.raw === undefined && skipStack.length < MAX_SKIP_DEPTH) skipStack.push(name);
      continue;
    }
    if (inHead && !HEAD_OK.has(name)) inHead = false;

    switch (name) {
      case 'html':
        if (!lang && attrs.lang) lang = attrs.lang.trim();
        continue;
      case 'head':
        inHead = true;
        continue;
      case 'body':
        inHead = false;
        break;
      case 'title':
        if (!title) title = collapse(tok.raw);
        continue;
      case 'meta':
        handleMeta(attrs);
        continue;
      case 'link': {
        const rel = collapse(attrs.rel).toLowerCase().split(' ');
        if (!canonical && rel.includes('canonical')) canonical = resolve(attrs.href);
        continue;
      }
      case 'base':
        continue;
      default:
        break;
    }
    if (tok.raw !== undefined) continue; // script/style/noscript/iframe/textarea...
    if (SKIP.has(name) || ('hidden' in attrs && !VOID.has(name))) {
      if (!tok.selfClosing && !VOID.has(name)) skipStack.push(name);
      continue;
    }

    if (name === 'br') {
      if (inPre) preText += '\n';
      else pieces.push({ t: BR, m: BR });
      continue;
    }
    if (name === 'img') {
      const f = frames.findLast((x) => x.tag === 'a');
      if (f && !f.alt && attrs.alt) f.alt = collapse(attrs.alt);
      continue;
    }
    if (name === 'area') {
      const url = resolve(attrs.href);
      if (url) recordLink(url, attrs.alt || '', attrs.rel || '');
      continue;
    }

    const frameTag = INLINE_FRAME[name];
    if (frameTag) {
      if (frameTag === 'a') {
        const open = frames.findIndex((f) => f.tag === 'a');
        if (open !== -1) closeFrameAt(open);
        const url = resolve(attrs.href);
        if (!url) continue;
        const entry = recordLink(url, '', attrs.rel || '');
        frames.push({ tag: 'a', start: pieces.length, depth: stack.length, entry, alt: '', inPre, preStart: preText.length });
      } else if (frames.some((f) => f.tag === frameTag)) {
        // <b> inside <b> adds nothing; remember it so its end tag is consumed too.
        // This keeps at most one frame per kind open (bounded work per block).
        ignoredInline[frameTag]++;
      } else if (!inPre) {
        frames.push({ tag: frameTag, start: pieces.length, depth: stack.length });
      }
      continue;
    }

    if (inPre) continue;
    if (BLOCK.has(name)) {
      if (name !== 'html' && name !== 'body') openBlock(name, attrs);
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (pieces.some((p) => /\S/.test(p.t))) pieces.push({ t: ' ', m: ' | ' });
    }
  }
  closeBlocksTo(0);
  flush();

  let text = '';
  let markdown = '';
  let prev = null;
  for (const b of blocks) {
    // Items of the same (outermost) list stay tight; everything else is a paragraph break.
    const sep = !prev ? '' : b.kind === 'li' && prev.kind === 'li' && b.list === prev.list ? '\n' : '\n\n';
    text += sep + b.t;
    markdown += sep + b.m;
    prev = b;
  }

  if (!title) title = ogTitle || headings.find((h) => h.level === 1)?.text || '';
  return {
    title,
    description: description || ogDescription,
    lang: lang || metaLang,
    canonical,
    metaRobots,
    headings,
    text,
    markdown,
    links: [...links.values()],
    wordCount: countWords(text),
  };
}

function countWords(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

function emptyRobots() {
  return { noindex: false, nofollow: false, noarchive: false, nosnippet: false };
}

// Plain-text (or HTML, dispatched) body -> same shape as extractHtml.
export function extractText(body, contentType = 'text/plain', { baseUrl = null, botTokens = [] } = {}) {
  const type = String(contentType || '').toLowerCase();
  if (/html|xhtml/.test(type)) return extractHtml(body, baseUrl, { botTokens });
  const raw = String(body ?? '').replace(/^\u{feff}/u, '').replace(/\r\n?/g, '\n');
  const paragraphs = raw
    .split(/\n[ \t]*\n+/)
    .map((p) => p.split('\n').map((line) => line.replace(/[ \t\f\v\xa0]+/g, ' ').trim()).filter(Boolean).join('\n'))
    .filter(Boolean);
  const text = paragraphs.join('\n\n');
  const firstLine = text.split('\n', 1)[0] || '';
  return {
    title: firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine,
    description: '',
    lang: '',
    canonical: null,
    metaRobots: emptyRobots(),
    headings: [],
    text,
    markdown: text,
    links: [],
    wordCount: countWords(text),
  };
}
