// Per-origin robots.txt cache with RFC 9309 §2.3.1 status handling:
//   2xx            → parse the body
//   4xx (not 429)  → "unavailable": allow everything
//   429, 5xx, net  → "unreachable": reuse the last good copy if any (stale), else disallow everything
//   3xx (redirects already exhausted by fetchRobots) → treated as unavailable
import { parseRobots, RobotsTxt } from './parser.js';
import { robotsTokens } from '../identity.js';
import { originOf, robotsUrlFor } from '../util/url.js';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// RFC 9309 §2.4: a cached copy SHOULD NOT be used for more than 24 hours.
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// Unreachable results are retried soon; never trust a failure for longer than this.
export const MAX_FAILURE_TTL_MS = 10 * 60 * 1000;
// Origins remembered at once; expired entries go first, then least recently refreshed.
export const DEFAULT_MAX_ENTRIES = 2000;

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 500 && status !== 429) return 'unavailable';
  return 'unreachable';
}

function resolveOrigin(url) {
  try {
    return { origin: originOf(url), robotsUrl: robotsUrlFor(url) };
  } catch {
    throw new TypeError(`Invalid URL for robots.txt lookup: ${url}`);
  }
}

export class RobotsCache {
  // ttlMs may be a number or a getter (read at use time, so live config edits apply).
  constructor({ ttlMs = DEFAULT_TTL_MS, fetchRobots, audit = null, now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (typeof fetchRobots !== 'function') throw new TypeError('RobotsCache requires a fetchRobots function');
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.fetchRobots = fetchRobots;
    this.audit = audit;
    this.now = now;
    this._entries = new Map(); // origin → entry
    this._inflight = new Map(); // origin → {token, promise}
  }

  get size() {
    return this._entries.size;
  }

  // Current TTL: resolved on every use and capped at 24 h.
  ttl() {
    const raw = typeof this.ttlMs === 'function' ? this.ttlMs() : this.ttlMs;
    const n = Number(raw);
    return Math.min(Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS, MAX_TTL_MS);
  }

  // An entry also expires early when the TTL has been lowered since it was fetched.
  _expiresAt(entry) {
    return Math.min(entry.expiresAt, entry.fetchedAt + this.ttl());
  }

  async get(url, role = 'search') {
    const { origin, robotsUrl } = resolveOrigin(url);
    const entry = this._entries.get(origin);
    if (entry && this.now() < this._expiresAt(entry)) return this._view(entry, entry.stale ? 'stale' : 'cache');

    const pending = this._inflight.get(origin);
    if (pending) return pending.promise;

    const token = {};
    const promise = this._refresh(origin, robotsUrl, role, token).finally(() => {
      if (this._inflight.get(origin)?.token === token) this._inflight.delete(origin);
    });
    this._inflight.set(origin, { token, promise });
    return promise;
  }

  async _refresh(origin, robotsUrl, role, token) {
    let res;
    try {
      res = await this.fetchRobots(robotsUrl, role);
    } catch (err) {
      res = { status: 0, body: null, error: err?.message || String(err) };
    }
    const status = Number(res?.status) || 0;
    const error = res?.error || null;
    const fetchedAt = this.now();
    const prev = this._entries.get(origin);
    const kind = classify(status);

    let entry;
    if (kind === 'ok' || kind === 'unavailable') {
      const robots =
        kind === 'ok'
          ? parseRobots(res?.body ?? '')
          : RobotsTxt.allowAll(`robots.txt returned HTTP ${status}; treated as unavailable (allow all).`);
      entry = { origin, robotsUrl, robots, status, fetchedAt, expiresAt: fetchedAt + this.ttl(), stale: false, error: null };
      entry.lastGood = { robots, status, fetchedAt };
    } else {
      const failureTtl = Math.min(this.ttl(), MAX_FAILURE_TTL_MS);
      const why = status === 0 ? `network error${error ? ` (${error})` : ''}` : `HTTP ${status}`;
      const lastGood = prev?.lastGood || null;
      const robots = lastGood
        ? lastGood.robots
        : RobotsTxt.disallowAll(`robots.txt unreachable (${why}); treated as disallow-all.`);
      entry = {
        origin,
        robotsUrl,
        robots,
        status,
        fetchedAt,
        expiresAt: fetchedAt + failureTtl,
        stale: Boolean(lastGood),
        staleFrom: lastGood ? lastGood.fetchedAt : null,
        error: error || why,
        lastGood,
      };
      this.audit?.record({
        kind: 'system',
        event: 'robots-fallback',
        url: robotsUrl,
        detail: lastGood
          ? `robots.txt unreachable (${why}); using stale copy fetched at ${new Date(lastGood.fetchedAt).toISOString()}`
          : `robots.txt unreachable (${why}); disallowing all paths for ${origin} until retry`,
      });
    }

    // Only store if not invalidated/cleared while the fetch was in flight.
    if (this._inflight.get(origin)?.token === token) {
      this._entries.delete(origin); // re-insert so Map order tracks refresh recency
      this._entries.set(origin, entry);
      this._evict();
    }
    return this._view(entry, entry.stale ? 'stale' : 'network');
  }

  // Bound memory: drop expired entries first, then the least recently refreshed.
  _evict() {
    const max = Math.max(1, this.maxEntries || DEFAULT_MAX_ENTRIES);
    if (this._entries.size <= max) return;
    const now = this.now();
    for (const [origin, e] of this._entries) {
      if (this._entries.size <= max) return;
      if (now >= this._expiresAt(e)) this._entries.delete(origin);
    }
    for (const origin of this._entries.keys()) {
      if (this._entries.size <= max) return;
      this._entries.delete(origin);
    }
  }

  _view(entry, source) {
    return {
      robots: entry.robots,
      origin: entry.origin,
      robotsUrl: entry.robotsUrl,
      status: entry.status,
      fetchedAt: entry.fetchedAt,
      expiresAt: this._expiresAt(entry),
      source,
      error: entry.error,
      staleFrom: entry.staleFrom ?? null,
    };
  }

  async check(url, role = 'search') {
    const r = await this.get(url, role);
    const tokens = robotsTokens(role);
    const { allowed, rule, matchedAgent } = r.robots.isAllowed(tokens, url);
    return {
      allowed,
      rule,
      matchedAgent,
      robotsUrl: r.robotsUrl,
      crawlDelay: r.robots.crawlDelay(tokens),
      status: r.status,
      source: r.source,
      sitemaps: r.robots.sitemaps,
      fetchedAt: r.fetchedAt,
      expiresAt: r.expiresAt,
      // Set when the policy is synthetic (robots.txt missing or unreachable), so
      // callers can explain a block that no rule in a real file caused.
      note: r.robots.note || null,
    };
  }

  invalidate(originOrUrl) {
    let origin = originOrUrl;
    try {
      origin = originOf(originOrUrl);
    } catch {
      // not a URL; treat as a raw origin key
    }
    this._inflight.delete(origin);
    return this._entries.delete(origin);
  }

  clear() {
    this._entries.clear();
    this._inflight.clear();
  }

  entries() {
    return [...this._entries.values()].map((e) => ({
      origin: e.origin,
      robotsUrl: e.robotsUrl,
      status: e.status,
      fetchedAt: e.fetchedAt,
      expiresAt: this._expiresAt(e),
      groups: e.robots.groups.length,
      sitemaps: e.robots.sitemaps,
      stale: e.stale,
      expired: this.now() >= this._expiresAt(e),
    }));
  }
}
