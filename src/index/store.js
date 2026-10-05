// In-memory BM25 search index with passage retrieval for RAG and JSON
// persistence. Only documents are persisted; postings are rebuilt on load.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { tokenize, uniqueTerms } from './tokenize.js';
import { normalizeUrl, siteOf } from '../util/url.js';

export const BM25 = { k1: 1.2, b: 0.75 };
export const TITLE_WEIGHT = 2.5;
export const PASSAGE_WORDS = 120;
export const PASSAGE_OVERLAP = 20;
export const SNIPPET_WORDS = 30;

const TITLE_SHIFT = 0x100000; // body tf in the low bits, title tf above (one number per posting)
const PHRASE_BONUS = 1.25;
const PHRASE_CHECK_TOP = 50;
const SNIPPET_SCAN_WORDS = 20000;
const SNIPPET_SEEK_CHARS = 100000;
const PASSAGES_PER_DOC = 3;
const PASSAGE_CACHE_DOCS = 512;
const ELLIPSIS = '\u{2026}';

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function words(text, max = Infinity) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\S+/g)) {
    out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

// Overlapping word windows; the final window always ends at the last word.
export function splitPassages(text, size = PASSAGE_WORDS, overlap = PASSAGE_OVERLAP) {
  const w = words(text);
  if (!w.length) return [];
  const step = Math.max(1, size - overlap);
  const out = [];
  for (let start = 0; start < w.length; start += step) {
    out.push(w.slice(start, start + size).join(' '));
    if (start + size >= w.length) break;
  }
  return out;
}

function toIso(v) {
  if (v === undefined || v === null || v === '') return new Date().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}

function keyOf(url) {
  return typeof url === 'string' ? normalizeUrl(url) : null;
}

export function normalizeSite(s) {
  let v = String(s ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    try {
      v = new URL(v).hostname;
    } catch {
      /* fall through with the raw value */
    }
  }
  v = v.replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/^\.+|\.+$/g, '');
  return v || null;
}

// A site filter also matches subdomains ("example.com" matches "blog.example.com").
function siteMatches(docSite, filter) {
  const s = String(docSite || '').toLowerCase();
  return s === filter || s.endsWith(`.${filter}`);
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function termCounts(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function idfOf(N, df) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function bm25Term(idf, tf, len, avgLen) {
  const { k1, b } = BM25;
  return (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / (avgLen || 1)));
}

function sameIndexedContent(a, b) {
  return (
    a.contentHash === b.contentHash &&
    a.title === b.title &&
    a.description === b.description &&
    a.markdown === b.markdown &&
    a.nosnippet === b.nosnippet &&
    a.noarchive === b.noarchive &&
    a.canonical === b.canonical
  );
}

// Char offset of the first word that starts like a query term (stems are word prefixes,
// modulo a trailing e/i/y), or -1. Used to seek into very long documents.
function firstTermOffset(text, termSet) {
  const alts = [...termSet]
    .map((t) => (t.length > 4 ? t.replace(/[eiy]$/, '') : t))
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!alts.length) return -1;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})`, 'iu').exec(text);
  return m ? m.index : -1;
}

// ~30-word window covering the most distinct query terms (then most hits).
function bestWindow(fullText, termSet, size = SNIPPET_WORDS) {
  let text = String(fullText ?? '');
  let lead = false;
  if (termSet.size && text.length > SNIPPET_SEEK_CHARS) {
    const at = firstTermOffset(text, termSet);
    if (at > SNIPPET_SEEK_CHARS / 2) {
      const cut = Math.max(0, text.lastIndexOf(' ', Math.max(0, at - 400)));
      text = text.slice(cut);
      lead = cut > 0;
    }
  }
  const w = words(text, SNIPPET_SCAN_WORDS);
  if (!w.length) return '';
  const more = w.length >= SNIPPET_SCAN_WORDS;
  let start = 0;
  if (termSet.size) {
    const cache = new Map();
    const hits = w.map((word) => {
      let v = cache.get(word);
      if (v === undefined) {
        const matched = tokenize(word).filter((t) => termSet.has(t));
        v = matched.length ? matched : null;
        cache.set(word, v);
      }
      return v;
    });
    const counts = new Map();
    let distinct = 0;
    let total = 0;
    let best = -1;
    const addHits = (h, delta) => {
      if (!h) return;
      for (const t of h) {
        const c = (counts.get(t) || 0) + delta;
        if (c === 0) counts.delete(t);
        else counts.set(t, c);
        if (delta > 0 && c === 1) distinct++;
        if (delta < 0 && c === 0) distinct--;
        total += delta;
      }
    };
    for (let i = 0; i < w.length; i++) {
      addHits(hits[i], 1);
      if (i >= size) addHits(hits[i - size], -1);
      const score = distinct * 1e6 + total;
      if (score > best) {
        best = score;
        start = Math.max(0, i - size + 1);
      }
    }
    // Slide forward so the first hit has a little leading context, not a full window of it.
    const first = hits.findIndex((h, i) => i >= start && h);
    if (first !== -1) start = Math.max(start, Math.min(first - 4, w.length - size));
    start = Math.max(0, start);
  }
  const end = Math.min(w.length, start + size);
  const body = w.slice(start, end).join(' ');
  return `${start > 0 || lead ? `${ELLIPSIS} ` : ''}${body}${end < w.length || more ? ` ${ELLIPSIS}` : ''}`;
}

export class SearchIndex {
  constructor({ file = null } = {}) {
    this.file = file;
    this.lastUpdated = null;
    this._reset();
    this._saveTimer = null;
    this._saveFirstAt = 0;
    this._saveChain = Promise.resolve();
  }

  _reset() {
    this._docs = new Map(); // url → record {id, doc, len, terms, passages, pstats?}
    this._byId = new Map();
    this._postings = new Map(); // term → Map<docId, packed tf>
    this._hashes = new Map(); // contentHash → Set<url>
    this._nextId = 1;
    this._totalLen = 0;
    this._passageCount = 0;
    this._pstatsLru = new Map();
  }

  get size() {
    return this._docs.size;
  }

  _touch() {
    this.lastUpdated = new Date().toISOString();
  }

  _normalizeDoc(input, url) {
    const str = (v) => (v === undefined || v === null ? '' : String(v));
    const text = str(input.text);
    return {
      url,
      title: str(input.title).trim(),
      description: str(input.description).trim(),
      text,
      markdown: str(input.markdown),
      headings: Array.isArray(input.headings) ? input.headings : [],
      lang: str(input.lang),
      site: input.site ? String(input.site).toLowerCase() : siteOf(url),
      fetchedAt: toIso(input.fetchedAt),
      role: input.role ? String(input.role) : 'search',
      contentHash: input.contentHash ? String(input.contentHash) : sha256(text),
      canonical: input.canonical || null,
      noarchive: Boolean(input.noarchive),
      nosnippet: Boolean(input.nosnippet),
      wordCount: Number.isFinite(input.wordCount) ? input.wordCount : words(text).length,
    };
  }

  _put(doc) {
    const prev = this._docs.get(doc.url);
    if (prev) this._unindex(prev);
    const id = this._nextId++;
    const titleTokens = tokenize(doc.title);
    const bodyTokens = tokenize(doc.description ? `${doc.description}\n${doc.text}` : doc.text);
    const tf = new Map();
    for (const t of bodyTokens) tf.set(t, Math.min(TITLE_SHIFT - 1, (tf.get(t) || 0) + 1));
    for (const t of titleTokens) tf.set(t, (tf.get(t) || 0) + TITLE_SHIFT);
    for (const [term, packed] of tf) {
      let p = this._postings.get(term);
      if (!p) this._postings.set(term, (p = new Map()));
      p.set(id, packed);
    }
    const rec = {
      id,
      doc,
      len: bodyTokens.length + titleTokens.length,
      terms: [...tf.keys()],
      passages: splitPassages(doc.text),
    };
    this._docs.set(doc.url, rec);
    this._byId.set(id, rec);
    this._totalLen += rec.len;
    this._passageCount += rec.passages.length;
    let urls = this._hashes.get(doc.contentHash);
    if (!urls) this._hashes.set(doc.contentHash, (urls = new Set()));
    urls.add(doc.url);
    return rec;
  }

  _unindex(rec) {
    for (const term of rec.terms) {
      const p = this._postings.get(term);
      if (!p) continue;
      p.delete(rec.id);
      if (!p.size) this._postings.delete(term);
    }
    this._totalLen -= rec.len;
    this._passageCount -= rec.passages.length;
    const urls = this._hashes.get(rec.doc.contentHash);
    if (urls) {
      urls.delete(rec.doc.url);
      if (!urls.size) this._hashes.delete(rec.doc.contentHash);
    }
    this._docs.delete(rec.doc.url);
    this._byId.delete(rec.id);
    this._pstatsLru.delete(rec.id);
  }

  add(input) {
    if (!input || typeof input !== 'object') throw new TypeError('SearchIndex.add: a doc object is required');
    const url = keyOf(input.url);
    if (!url) throw new TypeError(`SearchIndex.add: doc.url must be an absolute http(s) URL (got ${input.url})`);
    const doc = this._normalizeDoc(input, url);
    const prev = this._docs.get(url);
    if (prev && sameIndexedContent(prev.doc, doc)) {
      prev.doc.fetchedAt = doc.fetchedAt;
      prev.doc.role = doc.role;
      return 'unchanged';
    }
    this._put(doc);
    this._touch();
    return prev ? 'updated' : 'added';
  }

  remove(url) {
    const rec = this._docs.get(keyOf(url) ?? url);
    if (!rec) return false;
    this._unindex(rec);
    this._touch();
    return true;
  }

  has(url) {
    return this._docs.has(keyOf(url) ?? url);
  }

  get(url) {
    const rec = this._docs.get(keyOf(url) ?? url);
    return rec ? { ...rec.doc } : null;
  }

  findByHash(hash) {
    const urls = this._hashes.get(hash);
    if (!urls || !urls.size) return null;
    return urls.values().next().value;
  }

  clear() {
    this._reset();
    this._touch();
  }

  // Scored doc records for the given terms, best first.
  _rank(terms, siteFilter, rawQuery = '') {
    const N = this._docs.size;
    if (!N || !terms.length) return [];
    const avgLen = this._totalLen / N;
    const scores = new Map();
    for (const term of terms) {
      const p = this._postings.get(term);
      if (!p) continue;
      const idf = idfOf(N, p.size);
      for (const [id, packed] of p) {
        const rec = this._byId.get(id);
        if (siteFilter && !siteMatches(rec.doc.site, siteFilter)) continue;
        const tf = (packed % TITLE_SHIFT) + TITLE_WEIGHT * Math.floor(packed / TITLE_SHIFT);
        const s = bm25Term(idf, tf, rec.len, avgLen);
        const e = scores.get(id);
        if (e) e.score += s;
        else scores.set(id, { rec, score: s });
      }
    }
    const ranked = [...scores.values()];
    const byScore = (a, b) => b.score - a.score || (a.rec.doc.url < b.rec.doc.url ? -1 : 1);
    ranked.sort(byScore);

    // Exact-phrase bonus for multi-word queries, applied to the head of the list only.
    const phrase = String(rawQuery).toLowerCase().replace(/\s+/g, ' ').trim();
    if (terms.length > 1 && phrase.includes(' ')) {
      const head = ranked.slice(0, PHRASE_CHECK_TOP);
      for (const e of head) {
        const hay = `${e.rec.doc.title} ${e.rec.doc.text.slice(0, 100000)}`.toLowerCase().replace(/\s+/g, ' ');
        if (hay.includes(phrase)) e.score *= PHRASE_BONUS;
      }
      head.sort(byScore);
      ranked.splice(0, head.length, ...head);
    }
    return ranked;
  }

  _parseQuery(query, site) {
    let q = String(query ?? '');
    let siteFilter = site ? normalizeSite(site) : null;
    const m = /(?:^|\s)site:(\S+)/i.exec(q);
    if (m) {
      if (!siteFilter) siteFilter = normalizeSite(m[1]);
      q = q.replace(m[0], ' ');
    }
    return { q, siteFilter, terms: uniqueTerms(q) };
  }

  search(query, { limit = 10, offset = 0, site } = {}) {
    const t0 = performance.now();
    const { q, siteFilter, terms } = this._parseQuery(query, site);
    const ranked = this._rank(terms, siteFilter, q);
    const lim = clampInt(limit, 1, 100, 10);
    const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const termSet = new Set(terms);
    const results = ranked.slice(off, off + lim).map(({ rec, score }) => ({
      url: rec.doc.url,
      title: rec.doc.title || rec.doc.url,
      snippet: rec.doc.nosnippet ? '' : bestWindow(rec.doc.text || rec.doc.description, termSet),
      score: round(score),
      site: rec.doc.site,
      fetchedAt: rec.doc.fetchedAt,
    }));
    return { query: String(query ?? ''), total: ranked.length, tookMs: round(performance.now() - t0, 2), results };
  }

  _passageStats(rec) {
    if (!rec.pstats) {
      rec.pstats = rec.passages.map((p) => {
        const toks = tokenize(p);
        return { tf: termCounts(toks), len: toks.length };
      });
    }
    // Bounded LRU so passage term stats don't grow with the whole index.
    this._pstatsLru.delete(rec.id);
    this._pstatsLru.set(rec.id, rec);
    if (this._pstatsLru.size > PASSAGE_CACHE_DOCS) {
      const [oldId, oldRec] = this._pstatsLru.entries().next().value;
      this._pstatsLru.delete(oldId);
      delete oldRec.pstats;
    }
    return rec.pstats;
  }

  // Passage-level retrieval for RAG: rank docs, then rerank their passages.
  // nosnippet docs contribute at most their title, never body text.
  searchPassages(query, { limit = 8, site } = {}) {
    const { q, siteFilter, terms } = this._parseQuery(query, site);
    const lim = clampInt(limit, 1, 100, 8);
    const ranked = this._rank(terms, siteFilter, q).slice(0, Math.max(lim * 4, 24));
    if (!ranked.length) return [];
    const N = this._docs.size;
    const idf = new Map(terms.map((t) => [t, idfOf(N, this._postings.get(t)?.size || 0)]));

    const scoredDocs = ranked.map((e) => ({ ...e, stats: e.rec.doc.nosnippet ? null : this._passageStats(e.rec) }));
    let lenSum = 0;
    let lenCount = 0;
    for (const e of scoredDocs) {
      for (const ps of e.stats || []) {
        lenSum += ps.len;
        lenCount++;
      }
    }
    const avgLen = lenCount ? lenSum / lenCount : 1;

    const out = [];
    for (const { rec, score, stats } of scoredDocs) {
      const { url, title } = rec.doc;
      if (!stats) {
        if (title && tokenize(title).some((t) => idf.has(t))) out.push({ url, title, text: title, score: 0.4 * score });
        continue;
      }
      const passages = [];
      stats.forEach((ps, i) => {
        let s = 0;
        for (const t of terms) {
          const tf = ps.tf.get(t);
          if (tf) s += bm25Term(idf.get(t), tf, ps.len, avgLen);
        }
        if (s > 0) passages.push({ i, s });
      });
      // Matched on title/description only: the lead passage is the best context we have.
      if (!passages.length && rec.passages.length) passages.push({ i: 0, s: 0 });
      passages.sort((a, b) => b.s - a.s || a.i - b.i);
      for (const { i, s } of passages.slice(0, PASSAGES_PER_DOC)) {
        out.push({ url, title: title || url, text: rec.passages[i], score: 0.6 * s + 0.4 * score });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const results = [];
    for (const p of out) {
      if (seen.has(p.text)) continue;
      seen.add(p.text);
      results.push({ ...p, score: round(p.score) });
      if (results.length >= lim) break;
    }
    return results;
  }

  list({ site, limit = 50, offset = 0 } = {}) {
    const f = site ? normalizeSite(site) : null;
    let docs = [...this._docs.values()].map((r) => r.doc);
    if (f) docs = docs.filter((d) => siteMatches(d.site, f));
    docs.sort((a, b) => (a.fetchedAt === b.fetchedAt ? (a.url < b.url ? -1 : 1) : a.fetchedAt < b.fetchedAt ? 1 : -1));
    const lim = clampInt(limit, 1, 10000, 50);
    const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
    return {
      total: docs.length,
      docs: docs.slice(off, off + lim).map(({ url, title, site: s, fetchedAt, wordCount, role }) => ({
        url,
        title,
        site: s,
        fetchedAt,
        wordCount,
        role,
      })),
    };
  }

  stats() {
    const sites = new Map();
    for (const { doc } of this._docs.values()) sites.set(doc.site, (sites.get(doc.site) || 0) + 1);
    return {
      docs: this._docs.size,
      passages: this._passageCount,
      terms: this._postings.size,
      sites: [...sites]
        .map(([site, docs]) => ({ site, docs }))
        .sort((a, b) => b.docs - a.docs || (a.site < b.site ? -1 : 1)),
      lastUpdated: this.lastUpdated,
    };
  }

  // Persistence --------------------------------------------------------------

  async save() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.file) return;
    const run = () => this._writeSnapshot();
    this._saveChain = this._saveChain.then(run, run); // serialize writers
    return this._saveChain;
  }

  async _writeSnapshot() {
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      lastUpdated: this.lastUpdated,
      docs: [...this._docs.values()].map((r) => r.doc),
    });
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmp, payload);
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  // Debounced save; a steady stream of calls still saves at least every max(5·ms, 5 s).
  scheduleSave(ms = 1000) {
    if (!this.file) return;
    const now = Date.now();
    const maxWait = Math.max(ms * 5, 5000);
    if (this._saveTimer) {
      if (now - this._saveFirstAt >= maxWait) return;
      clearTimeout(this._saveTimer);
    } else {
      this._saveFirstAt = now;
    }
    const delay = Math.max(0, Math.min(ms, this._saveFirstAt + maxWait - now));
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch((err) => console.error(`[cairn] index save failed: ${err.message}`));
    }, delay);
    this._saveTimer.unref?.();
  }

  async load() {
    if (!this.file) return { loaded: 0 };
    let raw;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { loaded: 0 };
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // Keep the unreadable file for inspection rather than overwriting it on the next save.
      const aside = `${this.file}.corrupt-${Date.now()}`;
      await fs.promises.rename(this.file, aside).catch(() => {});
      console.error(`[cairn] index file unreadable (${err.message}); moved to ${aside}`);
      return { loaded: 0 };
    }
    this._reset();
    const docs = Array.isArray(data) ? data : Array.isArray(data?.docs) ? data.docs : [];
    for (const d of docs) {
      const url = d && keyOf(d.url);
      if (url) this._put(this._normalizeDoc(d, url));
    }
    this.lastUpdated = data?.lastUpdated ?? (this._docs.size ? new Date().toISOString() : null);
    return { loaded: this._docs.size };
  }
}
