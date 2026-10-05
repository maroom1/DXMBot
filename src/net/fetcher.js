// The only way Cairn touches the network. Every request is identified (UA,
// From, Web Bot Auth signature), robots-checked on every redirect hop,
// rate-limited per host, size- and time-bounded, and audited per attempt.
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import { RobotsCache } from '../robots/cache.js';
import { getRole, userAgent } from '../identity.js';
import { normalizeUrl, hostOf, isPrivateHost } from '../util/url.js';
import { HostScheduler } from './ratelimit.js';

export const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,text/plain;q=0.9,application/xml;q=0.8,*/*;q=0.5';
const RAW_MAX_REDIRECTS = 5;
// Retry-After values longer than this are recorded in the scheduler (so later
// requests to the host wait) but not waited out inside a single fetch.
const MAX_INLINE_RETRY_WAIT_MS = 60000;
// A robots Crawl-delay above this is not queued for (a hostile or extreme value
// would hold requests for days); the site is treated as disallowing Cairn.
export const MAX_CRAWL_DELAY_SEC = 300;
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(pdf|octet-stream|zip|gzip|x-gzip|x-tar|x-7z-compressed|vnd\.|msword|x-rar)/i;

function emptyXRobots() {
  return { noindex: false, nofollow: false, noarchive: false, nosnippet: false };
}

// X-Robots-Tag: "noindex, nofollow" or bot-scoped "CairnSearch: noindex".
// Directives that themselves take a value (max-snippet: 20, ...) are not scopes.
//
// Fetch joins repeated X-Robots-Tag lines with ", ", so "otherbot: noindex" +
// "nofollow" arrives as "otherbot: noindex, nofollow" and it is impossible to
// tell whether "nofollow" continues otherbot's line or is a separate, unscoped
// line. Fail closed: only the directive attached to a foreign "<bot>:" prefix
// is skipped; bare directives always apply (they are all restrictions).
const VALUE_DIRECTIVES = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);
export function parseXRobotsTag(value, tokens = []) {
  const out = emptyXRobots();
  if (!value) return out;
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  for (let part of String(value).split(',')) {
    part = part.trim();
    if (!part) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(part);
    if (m && !VALUE_DIRECTIVES.has(m[1].toLowerCase())) {
      const scope = m[1].toLowerCase();
      part = m[2].trim();
      if (!part || (scope !== '*' && !wanted.has(scope))) continue;
    }
    const d = part.toLowerCase().replace(/\s*:\s*/g, ':');
    if (d === 'none') {
      out.noindex = true;
      out.nofollow = true;
    } else if (d === 'nocache') {
      out.noarchive = true;
    } else if (d === 'max-snippet:0') {
      out.nosnippet = true;
    } else if (d in out) {
      out[d] = true;
    }
  }
  return out;
}

function charsetOf(contentType) {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : 'utf-8';
}

function decode(bytes, contentType) {
  let decoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of headers) out[k.toLowerCase()] = v;
  return out;
}

function isRetryable(res) {
  if (res.aborted || res.timedOut) return false;
  if (res.status === 0) return true;
  return res.status === 429 || res.status >= 500;
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export class Fetcher {
  constructor({ config, scheduler, signer = null, audit = null, fetchImpl = globalThis.fetch, lookup = dnsPromises.lookup } = {}) {
    if (!config) throw new Error('Fetcher requires a config');
    this.config = config;
    this.lookup = lookup;
    this.scheduler = scheduler || new HostScheduler(config.politeness);
    this.signer = signer;
    this.audit = audit;
    this.fetchImpl = fetchImpl;
    this.robots = new RobotsCache({
      // A getter, so POST /api/config changes apply without a restart.
      ttlMs: () => this.config.robots?.cacheTtlMs,
      fetchRobots: (robotsUrl, role) => this.fetchRaw(robotsUrl, { role, kind: 'robots' }),
      audit,
    });
  }

  async checkRobots(url, role = 'search') {
    const norm = normalizeUrl(url);
    if (!norm) throw new Error(`Invalid URL: ${url}`);
    getRole(role);
    return this.robots.check(norm, role);
  }

  // Classifies a URL before any network activity; returns a block or null.
  preflight(url, base) {
    const norm = normalizeUrl(url, base);
    if (!norm) {
      let parsed = null;
      try {
        parsed = base ? new URL(url, base) : new URL(url);
      } catch {
        // not a URL at all
      }
      if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { url: parsed.href, block: { reason: 'scheme', detail: `Unsupported scheme ${parsed.protocol}` } };
      }
      return { url: String(url), block: { reason: 'invalid-url', detail: 'Not an absolute http(s) URL' } };
    }
    if (this.config.fetch?.blockPrivateNetworks && isPrivateHost(new URL(norm).hostname)) {
      return { url: norm, block: { reason: 'private-network', detail: `${new URL(norm).hostname} is a private or loopback address` } };
    }
    return { url: norm, block: null };
  }

  // preflight plus, when private networks are blocked, a DNS check so names that
  // resolve to loopback/intranet addresses (127.0.0.1.nip.io, rebinding names)
  // are refused too. Lookup failures are left to the request itself to report.
  async screen(url, base) {
    const pre = this.preflight(url, base);
    if (pre.block || !this.config.fetch?.blockPrivateNetworks) return pre;
    const hostname = new URL(pre.url).hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname)) return pre;
    let addrs = [];
    try {
      addrs = await this.lookup(hostname, { all: true });
    } catch {
      return pre;
    }
    const bad = (Array.isArray(addrs) ? addrs : [addrs]).find((a) => a && isPrivateHost(String(a.address ?? a)));
    if (bad) {
      return { url: pre.url, block: { reason: 'private-network', detail: `${hostname} resolves to private or loopback address ${bad.address ?? bad}` } };
    }
    return pre;
  }

  async fetch(url, { role = 'search', respectRobots, accept, maxBytes, signal, method = 'GET' } = {}) {
    const r = getRole(role);
    const started = Date.now();
    const config = this.config;
    // Only user-triggered fetches may skip robots.txt (config or explicit
    // override); the search and corpus crawlers always obey it.
    const respect = role === 'user' ? (respectRobots ?? config.robots.respectForUserFetch !== false) : true;
    const limit = maxBytes ?? config.fetch.maxBytes;
    const maxRedirects = config.fetch.maxRedirects ?? 5;
    const redirects = [];
    let signedAny = false;

    const result = (fields) => {
      const headers = fields.headers || {};
      const contentType = headers['content-type'] || null;
      const status = fields.status || null; // 0 (no response) is reported as null
      const blocked = fields.blocked || null;
      const error = fields.error || null;
      return {
        ok: !blocked && !error && status >= 200 && status < 300,
        url: first.url,
        finalUrl: fields.finalUrl,
        status,
        headers,
        contentType,
        body: fields.body ?? null,
        bytes: fields.bytes || 0,
        truncated: Boolean(fields.truncated),
        elapsedMs: Date.now() - started,
        redirects,
        blocked,
        error,
        role,
        userAgent: userAgent(role, config.publicBaseUrl),
        signed: signedAny,
        xRobotsTag: parseXRobotsTag(headers['x-robots-tag'], [r.token, 'Cairn']),
      };
    };
    const blockedResult = (target, block, robotsInfo = {}) => {
      this.record({
        kind: 'fetch',
        role,
        method,
        url: target,
        finalUrl: target,
        status: null,
        bytes: 0,
        elapsedMs: Date.now() - started,
        robots: robotsInfo.robots || 'skipped',
        rule: robotsInfo.rule || null,
        blocked: block.reason,
        signed: false,
        attempt: 0,
        error: null,
      });
      return result({ finalUrl: target, blocked: block });
    };

    const first = await this.screen(url);
    if (first.block) return blockedResult(first.url, first.block);

    let current = first.url;
    for (let hop = 0; ; hop++) {
      let robotsInfo = { robots: 'skipped', rule: null };
      let crawlDelaySec;
      if (respect && new URL(current).pathname !== '/robots.txt') {
        let check;
        try {
          check = await this.robots.check(current, role);
        } catch (err) {
          return result({ finalUrl: current, error: `robots check failed: ${err.message}` });
        }
        // The decision for the hop that was actually blocked (it may be a
        // redirect target on another origin, not the URL first requested).
        const decision = { ...check, url: current, allowed: false };
        delete decision.sitemaps;
        if (!check.allowed) {
          return blockedResult(
            current,
            {
              reason: 'robots',
              detail: `Disallowed by ${check.robotsUrl}${check.rule ? ` (${check.rule.type}: ${check.rule.path})` : ''}${check.note && check.source !== 'stale' ? ` — ${check.note}` : ''}`,
              rule: check.rule || null,
              robots: decision,
            },
            { robots: 'disallowed', rule: check.rule || null },
          );
        }
        if (typeof check.crawlDelay === 'number' && check.crawlDelay > MAX_CRAWL_DELAY_SEC) {
          return blockedResult(
            current,
            {
              reason: 'robots',
              detail: `Crawl-delay of ${check.crawlDelay} s in ${check.robotsUrl} exceeds Cairn's maximum of ${MAX_CRAWL_DELAY_SEC} s; treated as disallowed`,
              rule: null,
              robots: { ...decision, crawlDelayLimit: MAX_CRAWL_DELAY_SEC },
            },
            { robots: 'disallowed', rule: null },
          );
        }
        robotsInfo = { robots: 'allowed', rule: check.rule || null };
        crawlDelaySec = check.crawlDelay ?? undefined;
      }

      const res = await this.request(current, {
        role,
        kind: 'fetch',
        method,
        accept: accept || DEFAULT_ACCEPT,
        maxBytes: limit,
        signal,
        crawlDelaySec,
        robotsInfo,
        readBody: (status, headers) => !(isRedirect(status) && headers.location) && method !== 'HEAD',
      });
      signedAny = signedAny || res.signed;

      if (!res.error && isRedirect(res.status) && res.headers.location) {
        if (hop >= maxRedirects) {
          return result({ ...res, finalUrl: current, error: `Too many redirects (> ${maxRedirects})` });
        }
        const next = await this.screen(res.headers.location, current);
        redirects.push({ from: current, to: next.url, status: res.status });
        if (next.block) return blockedResult(next.url, next.block);
        current = next.url;
        continue;
      }

      let body = null;
      if (res.bodyBytes && !BINARY_TYPE.test(res.headers['content-type'] || '')) {
        body = decode(res.bodyBytes, res.headers['content-type']);
      }
      return result({ ...res, finalUrl: current, body });
    }
  }

  // Low-level GET without robots checks (used for robots.txt itself). Still
  // identified, signed, rate limited and audited; follows up to 5 redirects.
  async fetchRaw(url, { role = 'search', kind = 'fetch' } = {}) {
    getRole(role);
    // Same scheme/private-network screening as fetch(). A refusal is reported as
    // "no response" (status 0), which RobotsCache treats as unreachable.
    const first = await this.screen(url);
    if (first.block) return { status: 0, body: null, headers: {}, error: first.block.detail, finalUrl: first.url };
    let current = first.url;
    for (let hop = 0; ; hop++) {
      const res = await this.request(current, {
        role,
        kind,
        method: 'GET',
        accept: kind === 'robots' ? 'text/plain,*/*;q=0.5' : DEFAULT_ACCEPT,
        maxBytes: this.config.fetch.maxBytes,
        robotsInfo: { robots: 'skipped', rule: null },
        readBody: (status, headers) => !(isRedirect(status) && headers.location),
      });
      if (!res.error && isRedirect(res.status) && res.headers.location) {
        const next = await this.screen(res.headers.location, current);
        if (next.block) {
          // A redirect Cairn refuses to follow means the file was never read:
          // report "unreachable" (status 0), not the 3xx (which would allow all).
          return { status: 0, body: null, headers: res.headers, error: `robots.txt redirect refused: ${next.block.detail}`, finalUrl: current };
        }
        if (hop >= RAW_MAX_REDIRECTS) {
          // RFC 9309 §2.3.1.2: after more than 5 redirects robots.txt MAY be treated as unavailable.
          return { status: res.status, body: null, headers: res.headers, error: `Too many redirects (> ${RAW_MAX_REDIRECTS})`, finalUrl: current };
        }
        current = next.url;
        continue;
      }
      const body = res.bodyBytes ? decode(res.bodyBytes, res.headers['content-type']) : null;
      return { status: res.status, body, headers: res.headers, error: res.error, finalUrl: current };
    }
  }

  // One logical request to one URL: scheduled attempts with retry/backoff.
  async request(url, opts) {
    const host = hostOf(url);
    const retries = Math.max(0, this.config.fetch.retries ?? 0);
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await this.scheduler
        .schedule(host, () => this.attempt(url, opts), { crawlDelaySec: opts.crawlDelaySec, signal: opts.signal })
        .catch((err) => ({ status: 0, headers: {}, bytes: 0, error: err.message || 'Aborted', aborted: true, notStarted: true }));
      if (!res.notStarted) this.recordAttempt(url, opts, res, attempt);
      if (res.aborted) return res;
      if (!isRetryable(res)) {
        if (res.timedOut) this.scheduler.penalize(host);
        else if (res.status > 0 && res.status < 500) this.scheduler.reward(host);
        return res;
      }
      const retryAfterMs = HostScheduler.parseRetryAfter(res.headers['retry-after']);
      this.scheduler.penalize(host, retryAfterMs);
      if (attempt > retries || (retryAfterMs !== null && retryAfterMs > MAX_INLINE_RETRY_WAIT_MS)) return res;
    }
  }

  // A single HTTP exchange. Never throws; failures come back as {status: 0, error}.
  async attempt(url, { role, method, accept, maxBytes, signal, readBody }) {
    const started = Date.now();
    const config = this.config;
    const headers = {
      'User-Agent': userAgent(role, config.publicBaseUrl),
      Accept: accept,
      'Accept-Language': 'en',
      From: config.contact,
    };
    let sig = {};
    try {
      sig = this.signer ? this.signer.signRequest({ method, url }) || {} : {};
    } catch {
      sig = {};
    }
    Object.assign(headers, sig);
    const signed = Object.keys(sig).length > 0;

    const timeoutMs = config.fetch.timeoutMs;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('timeout'));
    }, timeoutMs);
    const onAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const out = { status: 0, headers: {}, bytes: 0, truncated: false, bodyBytes: null, error: null, signed, elapsedMs: 0 };
    try {
      const fetchImpl = this.fetchImpl;
      const res = await fetchImpl(url, { method, headers, redirect: 'manual', signal: ac.signal });
      out.status = res.status;
      out.headers = headersToObject(res.headers);
      if (res.body && readBody(res.status, out.headers)) {
        const { bytes, truncated } = await readLimited(res.body, maxBytes);
        out.bodyBytes = bytes;
        out.bytes = bytes.length;
        out.truncated = truncated;
      } else if (res.body) {
        await res.body.cancel().catch(() => {});
      }
    } catch (err) {
      out.status = 0;
      out.headers = {};
      out.bodyBytes = null;
      if (timedOut) {
        out.timedOut = true;
        out.error = `Timed out after ${timeoutMs} ms`;
      } else if (signal?.aborted) {
        out.aborted = true;
        out.error = 'Aborted';
      } else {
        const cause = err?.cause;
        out.error = cause?.code ? `${cause.code}: ${cause.message}` : err?.message || String(err);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      out.elapsedMs = Date.now() - started;
    }
    return out;
  }

  recordAttempt(url, { role, kind, method, robotsInfo }, res, attempt) {
    this.record({
      kind,
      role,
      method,
      url,
      finalUrl: url,
      status: res.status || null,
      bytes: res.bytes || 0,
      elapsedMs: res.elapsedMs,
      robots: robotsInfo?.robots || 'skipped',
      rule: robotsInfo?.rule || null,
      blocked: null,
      signed: Boolean(res.signed),
      attempt,
      error: res.error || null,
      ...(res.headers?.location ? { location: res.headers.location } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    });
  }

  record(entry) {
    if (!this.audit) return;
    try {
      this.audit.record({ token: getRole(entry.role).token, ...entry });
    } catch {
      // Auditing must never break a fetch.
    }
  }
}

// Reads a web ReadableStream up to maxBytes, cancelling the rest.
async function readLimited(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (total + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}
