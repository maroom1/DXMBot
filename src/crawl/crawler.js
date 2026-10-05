// A single crawl job: seeds + sitemaps → breadth-first frontier → compliant
// fetches through the shared Fetcher → extract → index (search role) or JSONL
// corpus (corpus role). Politeness (robots, crawl-delay, per-host pacing) is
// entirely the Fetcher/HostScheduler's job; the crawler never sleeps.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { robotsTokens } from '../identity.js';
import { normalizeUrl, originOf, siteOf } from '../util/url.js';
import { extractHtml, extractText } from '../extract/html.js';
import { parseSitemap } from '../extract/sitemap.js';
import { CorpusWriter } from './corpus.js';

export const CRAWL_ROLES = ['search', 'corpus'];
export const TERMINAL_STATES = new Set(['done', 'cancelled', 'error']);

const RECENT_LIMIT = 50;
const SITEMAP_MAX_LEVELS = 3; // a sitemap, its index children, their children
const SITEMAP_MAX_URLS = 1000;
const SITEMAP_MAX_FILES = 50;
const SITEMAP_ACCEPT = 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1';
const MAX_CONCURRENCY = 32;
// Memory bounds: links taken from one page, and pending frontier size (tied to
// the remaining page budget; nothing past it could ever be fetched anyway).
export const MAX_LINKS_PER_PAGE = 5000;
export const MAX_PENDING_FRONTIER = 100000;
const FRONTIER_PER_REMAINING_PAGE = 10;
// Outcomes after which a previously indexed page must leave the search index.
const REMOVE_FROM_INDEX = new Set(['noindex', 'blocked-robots', 'http-404', 'http-410']);
const CANCELLED = Symbol('cancelled');

let jobSeq = 0;
export function newJobId() {
  return `job-${++jobSeq}-${Date.now().toString(36)}`;
}

function toInt(value, fallback, min, max = Infinity) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return !['false', '0', 'no', 'off', ''].includes(value.toLowerCase());
  return Boolean(value);
}

function toPatternList(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter((p) => p.length > 0);
}

function compilePatterns(patterns, label) {
  return patterns.map((p) => {
    try {
      return new RegExp(p);
    } catch (err) {
      throw new Error(`Invalid ${label} pattern ${JSON.stringify(p)}: ${err.message}`);
    }
  });
}

function mimeOf(result) {
  const ct = result.contentType || result.headers?.['content-type'] || '';
  return String(ct).split(';')[0].trim().toLowerCase();
}

// 'html' | 'text' | null (not indexable).
function documentKind(mime, body) {
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/plain') return 'text';
  if (!mime && typeof body === 'string' && /^\s*(<!doctype\s+html|<html[\s>])/i.test(body)) return 'html';
  return null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isLinkNofollow(link) {
  return Boolean(link.nofollow) || /(^|\s)nofollow(\s|$)/i.test(link.rel || '');
}

function httpOk(result) {
  return typeof result.status === 'number' && result.status >= 200 && result.status < 300;
}

// Outcomes after which a page's canonical target cannot stand in for it.
const NON_INDEXABLE = new Set(['blocked-robots', 'error', 'skipped-type', 'noindex']);

export class CrawlJob extends EventEmitter {
  #config;
  #fetcher;
  #index;
  #audit;
  #corpus = null;

  #state = 'queued';
  #startedAt = null;
  #finishedAt = null;
  #error = null;
  #runPromise = null;
  #finished = false;

  #cancelled = false;
  #abort = new AbortController();
  #onCancel;
  #cancelSignal;

  #seedSites;
  #include;
  #exclude;

  #frontier = []; // [{url, depth}] consumed from #head (FIFO → breadth-first)
  #head = 0;
  #seen = new Set(); // every URL ever admitted to the frontier
  #processed = new Set(); // requested and final (post-redirect) URLs already handled
  #outcomes = new Map(); // url → outcome
  #hashes = new Map(); // contentHash → url accepted in this job
  #inFlight = new Set();
  #recent = [];
  #attempts = 0;
  #finalQueued = null; // pending frontier size frozen at finish (the frontier is then released)
  #active = 0;
  #discovering = false;
  #sitemapUrls = 0;
  #sitemapFiles = new Set();
  #resolveLoop = null;

  #counts = {
    discovered: 0,
    queued: 0,
    fetched: 0,
    indexed: 0,
    collected: 0,
    blockedRobots: 0,
    noindex: 0,
    duplicates: 0,
    errors: 0,
    skipped: 0,
  };

  constructor(opts = {}, { config, fetcher, index = null, audit = null } = {}) {
    super();
    this.setMaxListeners(100);
    if (!config) throw new Error('CrawlJob requires config');
    if (!fetcher) throw new Error('CrawlJob requires a fetcher');
    this.#config = config;
    this.#fetcher = fetcher;
    this.#index = index;
    this.#audit = audit;

    const role = opts.role || 'search';
    if (!CRAWL_ROLES.includes(role)) {
      throw new Error(`Crawl role must be one of ${CRAWL_ROLES.join(', ')} (got "${role}")`);
    }
    if (role === 'search' && !index) throw new Error('A search crawl requires an index');

    const rawSeeds = Array.isArray(opts.seeds) ? opts.seeds : [opts.seeds ?? opts.url].filter(Boolean);
    const seeds = [...new Set(rawSeeds.map((s) => normalizeUrl(String(s))).filter(Boolean))];
    if (!seeds.length) throw new Error('Crawl needs at least one valid http(s) seed URL');

    const d = config.crawl || {};
    const includePatterns = toPatternList(opts.includePatterns);
    const excludePatterns = toPatternList(opts.excludePatterns);
    this.#include = compilePatterns(includePatterns, 'include');
    this.#exclude = compilePatterns(excludePatterns, 'exclude');

    this.id = String(opts.id || newJobId());
    this.role = role;
    this.seeds = seeds;
    this.options = {
      maxPages: toInt(opts.maxPages, toInt(d.maxPages, 50, 1), 1),
      maxDepth: toInt(opts.maxDepth, toInt(d.maxDepth, 2, 0), 0),
      sameSiteOnly: toBool(opts.sameSiteOnly, d.sameSiteOnly ?? true),
      useSitemaps: toBool(opts.useSitemaps, d.useSitemaps ?? true),
      concurrency: toInt(opts.concurrency, toInt(d.concurrency, 4, 1, MAX_CONCURRENCY), 1, MAX_CONCURRENCY),
      includePatterns,
      excludePatterns,
    };
    this.#seedSites = new Set(seeds.map(siteOf));
    this.#cancelSignal = new Promise((resolve) => {
      this.#onCancel = () => resolve(CANCELLED);
    });
  }

  get state() {
    return this.#state;
  }

  run() {
    if (!this.#runPromise) this.#runPromise = this.#run();
    return this.#runPromise;
  }

  cancel() {
    if (TERMINAL_STATES.has(this.#state) || this.#cancelled) return this.status();
    this.#cancelled = true;
    this.#abort.abort();
    this.#onCancel();
    if (this.#state === 'queued') this.#finish('cancelled');
    else this.#resolveLoop?.();
    return this.status();
  }

  status() {
    return {
      id: this.id,
      state: this.#state,
      role: this.role,
      seeds: [...this.seeds],
      options: { ...this.options, includePatterns: [...this.options.includePatterns], excludePatterns: [...this.options.excludePatterns] },
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      counts: { ...this.#counts, queued: this.#finalQueued ?? this.#frontier.length - this.#head },
      inFlight: [...this.#inFlight],
      recent: this.#recent.map((r) => ({ ...r })),
      error: this.#error,
    };
  }

  toJSON() {
    return this.status();
  }

  async #run() {
    if (this.#state !== 'queued') return this.status();
    this.#startedAt = new Date().toISOString();
    this.#setState('running');
    this.#audit?.record({
      kind: 'crawl',
      jobId: this.id,
      event: 'start',
      url: this.seeds[0],
      detail: { role: this.role, seeds: this.seeds, options: this.options },
    });
    try {
      if (this.role === 'corpus') {
        this.#corpus = new CorpusWriter({ dataDir: this.#config.dataDir, jobId: this.id });
      }
      for (const seed of this.seeds) this.#enqueue(seed, 0, { force: true });
      await new Promise((resolve) => {
        this.#resolveLoop = resolve;
        if (this.options.useSitemaps && this.options.maxDepth >= 1) this.#startSitemapDiscovery();
        this.#pump();
      });
      if (this.#corpus) await this.#corpus.flush();
      this.#finish(this.#cancelled ? 'cancelled' : 'done');
    } catch (err) {
      this.#error = err?.message || String(err);
      this.#finish(this.#cancelled ? 'cancelled' : 'error');
    }
    return this.status();
  }

  // Starts as many fetches as concurrency and the page budget allow; resolves
  // the crawl loop once nothing is running, discovery is over, and either the
  // frontier is empty or the budget is spent.
  #pump() {
    if (this.#finished) return;
    if (this.#cancelled) {
      this.#resolveLoop?.();
      return;
    }
    const { concurrency, maxPages } = this.options;
    while (this.#active < concurrency && this.#attempts < maxPages && this.#head < this.#frontier.length) {
      const item = this.#frontier[this.#head++];
      if (this.#processed.has(item.url)) continue; // already reached via an earlier redirect
      this.#attempts++;
      this.#active++;
      this.#visit(item).finally(() => {
        this.#active--;
        this.#pump();
      });
    }
    const exhausted = this.#attempts >= maxPages || this.#head >= this.#frontier.length;
    if (this.#active === 0 && !this.#discovering && exhausted) this.#resolveLoop?.();
  }

  #inScope(url) {
    try {
      if (this.options.sameSiteOnly && !this.#seedSites.has(siteOf(url))) return false;
    } catch {
      return false;
    }
    if (this.#include.length && !this.#include.some((re) => re.test(url))) return false;
    if (this.#exclude.some((re) => re.test(url))) return false;
    return true;
  }

  // Seeds are always crawled (force); discovered URLs must be in scope.
  #enqueue(rawUrl, depth, { force = false } = {}) {
    if (this.#finished || this.#cancelled) return false;
    // Reclaim consumed frontier slots now and then so the array does not grow forever.
    if (this.#head > 1024 && this.#head * 2 > this.#frontier.length) {
      this.#frontier.splice(0, this.#head);
      this.#head = 0;
    }
    const url = normalizeUrl(rawUrl);
    if (!url || this.#seen.has(url)) return false;
    if (depth > this.options.maxDepth) return false;
    if (!force && !this.#inScope(url)) return false;
    if (!force) {
      const pending = this.#frontier.length - this.#head;
      const room = Math.min(MAX_PENDING_FRONTIER, Math.max(0, this.options.maxPages - this.#attempts) * FRONTIER_PER_REMAINING_PAGE);
      if (pending >= room) return false;
    }
    this.#seen.add(url);
    this.#counts.discovered++;
    this.#frontier.push({ url, depth });
    return true;
  }

  // Races a fetcher promise against cancellation so cancel() never waits on a
  // request queued behind a long host delay.
  #guard(promise) {
    const p = Promise.resolve(promise);
    p.catch(() => {});
    return Promise.race([p, this.#cancelSignal]);
  }

  #startSitemapDiscovery() {
    this.#discovering = true;
    this.#discoverSitemaps()
      .catch(() => {})
      .finally(() => {
        this.#discovering = false;
        this.#pump();
      });
  }

  async #discoverSitemaps() {
    const origins = [...new Set(this.seeds.map(originOf))];
    for (const origin of origins) {
      if (this.#cancelled) return;
      const candidates = [];
      try {
        if (this.#fetcher.robots?.get) {
          const res = await this.#guard(this.#fetcher.robots.get(`${origin}/`, this.role));
          if (res === CANCELLED) return;
          candidates.push(...(res?.robots?.sitemaps || []));
        } else if (this.#fetcher.checkRobots) {
          await this.#guard(this.#fetcher.checkRobots(`${origin}/`, this.role));
        }
      } catch {
        // No robots sitemaps; the fetcher still enforces robots on every URL.
      }
      candidates.push(`${origin}/sitemap.xml`);
      for (const sm of candidates) await this.#readSitemap(sm, 1);
    }
  }

  async #readSitemap(rawUrl, level) {
    if (this.#cancelled || level > SITEMAP_MAX_LEVELS) return;
    if (this.#sitemapUrls >= SITEMAP_MAX_URLS || this.#sitemapFiles.size >= SITEMAP_MAX_FILES) return;
    if (this.#attempts >= this.options.maxPages) return;
    const url = normalizeUrl(rawUrl);
    if (!url || this.#sitemapFiles.has(url)) return;
    this.#sitemapFiles.add(url);

    let res;
    try {
      res = await this.#guard(
        this.#fetcher.fetch(url, { role: this.role, accept: SITEMAP_ACCEPT, signal: this.#abort.signal }),
      );
    } catch {
      return;
    }
    if (res === CANCELLED || this.#cancelled || !res || res.blocked || !httpOk(res) || !res.body) return;

    let parsed;
    try {
      parsed = parseSitemap(res.body);
    } catch {
      return;
    }
    for (const entry of parsed?.urls || []) {
      if (this.#sitemapUrls >= SITEMAP_MAX_URLS) break;
      const loc = typeof entry === 'string' ? entry : entry?.loc;
      if (this.#enqueue(loc, 1)) {
        this.#sitemapUrls++;
        this.#pump(); // let idle workers pick up sitemap URLs straight away
      }
    }
    for (const child of parsed?.sitemaps || []) await this.#readSitemap(child, level + 1);
  }

  async #visit({ url, depth }) {
    this.#inFlight.add(url);
    this.#processed.add(url);
    let rec;
    try {
      rec = await this.#fetchAndProcess(url, depth);
    } catch (err) {
      rec = { outcome: 'error', status: null, title: null, detail: err?.message || String(err) };
    } finally {
      this.#inFlight.delete(url);
    }
    if (rec === CANCELLED || this.#cancelled || this.#finished) return;
    this.#dropFromIndex(rec, url);
    this.#record(url, depth, rec);
  }

  // The site owner has opted out (noindex, robots.txt) or the page is gone
  // (404/410): a copy indexed earlier must not keep being served.
  #dropFromIndex(rec, url) {
    if (this.role !== 'search' || !this.#index?.remove || !REMOVE_FROM_INDEX.has(rec.outcome)) return;
    if (rec.outcome === 'blocked-robots' && !rec.optOut) return;
    let removed = false;
    for (const u of new Set([url, rec.finalUrl].filter(Boolean))) {
      if (this.#index.has?.(u) && this.#index.remove(u)) removed = true;
    }
    if (removed) this.#index.scheduleSave?.();
  }

  async #fetchAndProcess(url, depth) {
    const result = await this.#guard(this.#fetcher.fetch(url, { role: this.role, signal: this.#abort.signal }));
    if (result === CANCELLED || this.#cancelled) return CANCELLED;
    if (!result) return { outcome: 'error', status: null, title: null, detail: 'no result' };

    if (result.blocked) {
      if (result.blocked.reason === 'robots') {
        // Only a real rule is an opt-out; a synthetic disallow-all (robots.txt
        // temporarily unreachable) or an extreme Crawl-delay is not.
        const d = result.blocked.robots;
        return { outcome: 'blocked-robots', status: null, title: null, optOut: Boolean(d && !d.note && !d.crawlDelayLimit) };
      }
      return { outcome: 'error', status: null, title: null, detail: `blocked: ${result.blocked.reason}` };
    }
    const status = typeof result.status === 'number' && result.status > 0 ? result.status : null;
    if (status === null) return { outcome: 'error', status: null, title: null, detail: result.error || 'no response' };
    const base = { status, fetched: true, title: null };
    if (!httpOk(result)) return { ...base, outcome: `http-${status}` };

    const finalUrl = normalizeUrl(result.finalUrl || result.url || url) || url;
    if (finalUrl !== url) {
      if (this.#processed.has(finalUrl)) return { ...base, outcome: 'duplicate', detail: `redirects to ${finalUrl}` };
      this.#processed.add(finalUrl);
    }

    const kind = documentKind(mimeOf(result), result.body);
    if (!kind) return { ...base, outcome: 'skipped-type' };

    const body = result.body ?? '';
    const botTokens = robotsTokens(this.role);
    const ex =
      kind === 'html'
        ? extractHtml(body, finalUrl, { botTokens })
        : extractText(body, result.contentType || 'text/plain', { baseUrl: finalUrl, botTokens });
    const title = ex?.title || null;
    const meta = ex?.metaRobots || {};
    const xrt = result.xRobotsTag || {};
    const noindex = Boolean(meta.noindex || xrt.noindex);
    const nofollow = Boolean(meta.nofollow || xrt.nofollow);

    if (!nofollow && depth + 1 <= this.options.maxDepth) {
      const links = ex?.links || [];
      for (let i = 0; i < links.length && i < MAX_LINKS_PER_PAGE; i++) {
        const link = links[i];
        if (link?.url && !isLinkNofollow(link)) this.#enqueue(link.url, depth + 1);
      }
    }
    if (noindex) return { ...base, title, outcome: 'noindex', finalUrl };

    const canonical = ex?.canonical ? normalizeUrl(ex.canonical, finalUrl) : null;
    if (canonical && canonical !== finalUrl && this.#canonicalCovered(canonical)) {
      return { ...base, title, outcome: 'duplicate', detail: `canonical ${canonical}` };
    }

    const text = ex?.text || '';
    const contentHash = sha256(text);
    const dupOf = this.#hashOwner(contentHash, finalUrl);
    if (dupOf) return { ...base, title, outcome: 'duplicate', detail: `same content as ${dupOf}` };
    this.#hashes.set(contentHash, finalUrl);

    const fetchedAt = new Date().toISOString();
    if (this.role === 'corpus') {
      this.#corpus.append({ url: finalUrl, title, text, fetchedAt, contentHash }).catch((err) => {
        this.#error = `corpus write failed: ${err.message}`;
      });
      return { ...base, title, outcome: 'collected' };
    }

    const nosnippet = Boolean(meta.nosnippet || xrt.nosnippet);
    const noarchive = Boolean(meta.noarchive || xrt.noarchive);
    this.#index.add({
      url: finalUrl,
      title: title || '',
      description: ex?.description || '',
      text,
      markdown: ex?.markdown || text,
      headings: ex?.headings || [],
      lang: ex?.lang || null,
      site: siteOf(finalUrl),
      fetchedAt,
      role: this.role,
      contentHash,
      canonical: canonical || null,
      noarchive,
      nosnippet,
    });
    this.#index.scheduleSave?.();
    return { ...base, title, outcome: 'indexed' };
  }

  // A non-self canonical makes this page a duplicate when the canonical URL is
  // already indexed, or is known to this job and not known to be unindexable.
  #canonicalCovered(canonical) {
    if (this.role === 'search' && this.#index.has?.(canonical)) return true;
    if (!this.#seen.has(canonical) && !this.#processed.has(canonical)) return false;
    const outcome = this.#outcomes.get(canonical);
    return !(outcome && (NON_INDEXABLE.has(outcome) || outcome.startsWith('http-')));
  }

  #hashOwner(hash, url) {
    const local = this.#hashes.get(hash);
    if (local && local !== url) return local;
    if (this.role === 'search') {
      const owner = this.#index.findByHash?.(hash);
      if (owner && owner !== url) return owner;
    }
    return null;
  }

  #record(url, depth, rec) {
    const c = this.#counts;
    const { outcome } = rec;
    if (rec.fetched) c.fetched++;
    if (outcome === 'indexed') c.indexed++;
    else if (outcome === 'collected') c.collected++;
    else if (outcome === 'blocked-robots') c.blockedRobots++;
    else if (outcome === 'noindex') c.noindex++;
    else if (outcome === 'duplicate') c.duplicates++;
    else if (outcome === 'skipped-type') c.skipped++;
    else c.errors++; // 'error' and 'http-<status>'
    this.#outcomes.set(url, outcome);

    const page = { url, outcome, status: rec.status ?? null, title: rec.title ?? null, depth };
    this.#recent.push({ ...page, ts: new Date().toISOString() });
    if (this.#recent.length > RECENT_LIMIT) this.#recent.splice(0, this.#recent.length - RECENT_LIMIT);
    this.#emitSafe('page', { jobId: this.id, ...page });
  }

  #setState(state) {
    this.#state = state;
    this.#emitSafe('state', this.status());
  }

  #finish(state) {
    if (this.#finished) return;
    this.#finished = true;
    this.#finishedAt = new Date().toISOString();
    this.#inFlight.clear();
    this.#state = state;
    // Finished jobs are kept around for status only: release the big URL sets.
    this.#finalQueued = Math.max(0, this.#frontier.length - this.#head);
    this.#frontier = [];
    this.#head = 0;
    this.#seen.clear();
    this.#processed.clear();
    this.#outcomes.clear();
    this.#hashes.clear();
    this.#audit?.record({
      kind: 'crawl',
      jobId: this.id,
      event: 'finish',
      url: this.seeds[0],
      detail: { role: this.role, state, counts: this.status().counts, error: this.#error },
    });
    const s = this.status();
    this.#emitSafe('state', s);
    this.#emitSafe('done', s);
  }

  // A throwing listener (e.g. a closed SSE socket) must never break the crawl.
  #emitSafe(event, payload) {
    try {
      this.emit(event, payload);
    } catch {
      // ignored
    }
  }
}
