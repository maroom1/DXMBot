// JSON API (/api/*). Security guards (Host, CSRF, content type, body size) are
// applied by app.js before anything here runs; handlers receive a parsed body.
// The helpers exported below are shared with bin/cairn.js so the CLI and the
// HTTP API always produce identical results.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROLES, ROLE_IDS, FAMILY_TOKEN, robotsTokens, userAgent } from '../identity.js';
import { EDITABLE_KEYS, PROJECT_ROOT, saveConfig } from '../config.js';
import { normalizeUrl, pathWithQuery, robotsUrlFor, siteOf } from '../util/url.js';
import { parseRobots } from '../robots/parser.js';
import { verifyRequest } from '../net/signing.js';
import { DEFAULT_ACCEPT, parseXRobotsTag } from '../net/fetcher.js';
import { extractHtml, extractText, lexHtml, parseRobotsDirectives } from '../extract/html.js';
import { claudeAvailable } from '../agent/claude.js';
import { answerQuestion } from '../agent/answer.js';
import { deepResearch } from '../agent/research.js';
import { openSSE } from './sse.js';
import { PREFIX as ASSISTANT_PREFIX, handleAssistantApi } from '../assistant/routes.js';

export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

// Same Accept header the Fetcher really sends, so sign-preview never drifts from it.
export { DEFAULT_ACCEPT };
export const JWKS_PATH = '/.well-known/http-message-signatures-directory';
const MAX_MARKDOWN = 20000;
const MAX_LINKS = 200;
const TERMINAL_JOB_STATES = new Set(['done', 'cancelled', 'error']);
const ASK_EVENT_TYPES = new Set(['status', 'retrieval', 'tool', 'tool_result', 'text']);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function optionalBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function requireUrl(value, name = 'url') {
  const url = typeof value === 'string' ? normalizeUrl(value) : null;
  if (!url) throw new HttpError(400, `${name} must be an absolute http(s) URL`);
  return url;
}

function requireRole(role, allowed = ROLE_IDS) {
  if (!allowed.includes(role)) throw new HttpError(400, `role must be one of: ${allowed.join(', ')}`);
  return role;
}

export function uptimeSec(runtime) {
  return Math.round((Date.now() - (runtime.startedAt || Date.now())) / 1000);
}

async function claudeStatus(config) {
  try {
    return await claudeAvailable(config);
  } catch (err) {
    return { available: false, bin: config.agent?.claudeBin, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the CLI)
// ---------------------------------------------------------------------------

export function identityInfo(runtime) {
  const { config, signer } = runtime;
  const base = config.publicBaseUrl;
  return {
    roles: ROLE_IDS.map((id) => {
      const r = ROLES[id];
      return {
        id,
        token: r.token,
        name: r.name,
        purpose: r.purpose,
        trigger: r.trigger,
        respectsRobots: id === 'user' ? config.robots.respectForUserFetch !== false : r.respectsRobots,
        userAgent: userAgent(id, base),
        robotsTokens: robotsTokens(id),
        ipRangesUrl: `${base}/bot/${r.ipFile}`,
      };
    }),
    familyToken: FAMILY_TOKEN,
    keyId: signer?.keyId ?? null,
    jwksUrl: `${base}${JWKS_PATH}`,
    botPageUrl: `${base}/bot`,
    contact: config.contact,
    signingEnabled: config.signing?.enabled !== false,
  };
}

export function ipRanges(runtime) {
  const { ipv4Prefixes = [], ipv6Prefixes = [] } = runtime.config.identity || {};
  return {
    creationTime: new Date(runtime.startedAt || Date.now()).toISOString(),
    prefixes: [...ipv4Prefixes.map((p) => ({ ipv4Prefix: p })), ...ipv6Prefixes.map((p) => ({ ipv6Prefix: p }))],
  };
}

export function configSubset(config) {
  return JSON.parse(JSON.stringify(Object.fromEntries(EDITABLE_KEYS.map((k) => [k, config[k]]))));
}

export function statsInfo(runtime) {
  return {
    index: runtime.index.stats(),
    audit: runtime.audit.stats(),
    hosts: runtime.scheduler.stats(),
    jobs: runtime.jobs.list(),
    robotsCache: runtime.robots.entries().length,
    uptimeSec: uptimeSec(runtime),
  };
}

// Type-check a partial config against the live config so a bad POST can never
// corrupt config.json (e.g. a string where the scheduler expects a number).
// Control characters (CR/LF would break the From/User-Agent headers of every request).
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// RFC 9309 §2.4: a cached robots.txt SHOULD NOT be used for more than 24 hours.
export const MAX_ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const NUMBER_LIMITS = { 'robots.cacheTtlMs': MAX_ROBOTS_TTL_MS };

function validateConfigPatch(patch, current, pathPrefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    const where = pathPrefix ? `${pathPrefix}.${key}` : key;
    // Own keys only: `in` would also accept inherited ones such as __proto__.
    if (!Object.hasOwn(current, key)) throw new HttpError(400, `Unknown config key: ${where}`);
    const existing = current[key];
    if (isPlainObject(existing)) {
      if (!isPlainObject(value)) throw new HttpError(400, `${where} must be an object`);
      validateConfigPatch(value, existing, where);
    } else if (typeof existing === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new HttpError(400, `${where} must be a non-negative number`);
      const max = NUMBER_LIMITS[where];
      if (max !== undefined && value > max) throw new HttpError(400, `${where} must be at most ${max}`);
    } else if (typeof existing === 'boolean') {
      if (typeof value !== 'boolean') throw new HttpError(400, `${where} must be a boolean`);
    } else if (typeof existing === 'string') {
      if (typeof value !== 'string' || value.length > 500) throw new HttpError(400, `${where} must be a string`);
      if (CONTROL_CHARS.test(value)) throw new HttpError(400, `${where} must not contain control characters`);
    } else if (Array.isArray(existing)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new HttpError(400, `${where} must be an array of strings`);
      if (value.some((v) => CONTROL_CHARS.test(v))) throw new HttpError(400, `${where} must not contain control characters`);
    } else {
      throw new HttpError(400, `${where} cannot be changed`);
    }
  }
}

export function updateConfig(runtime, patch) {
  if (!isPlainObject(patch)) throw new HttpError(400, 'Config patch must be a JSON object');
  const notEditable = Object.keys(patch).filter((k) => !EDITABLE_KEYS.includes(k));
  if (notEditable.length) throw new HttpError(400, `Not editable: ${notEditable.join(', ')}`);
  // The Claude binary path is an executable; it may only come from the environment or config.json on disk.
  if (isPlainObject(patch.agent) && 'claudeBin' in patch.agent) {
    throw new HttpError(400, 'agent.claudeBin cannot be changed over HTTP (set CAIRN_CLAUDE_BIN instead)');
  }
  validateConfigPatch(patch, runtime.config);
  saveConfig(runtime.config, patch);
  return configSubset(runtime.config);
}

function emptyDirectives() {
  return { noindex: false, nofollow: false, noarchive: false, nosnippet: false };
}

// <meta name="<token>"> directives for the given robots tokens (plus "robots").
function metaDirectives(html, tokens) {
  const names = new Set(['robots', ...tokens.map((t) => t.toLowerCase())]);
  const out = emptyDirectives();
  for (const tok of lexHtml(html)) {
    if (tok.type === 'start' && tok.name === 'meta' && names.has(String(tok.attrs?.name || '').trim().toLowerCase())) {
      parseRobotsDirectives(tok.attrs.content ?? '', out);
    }
  }
  return out;
}

function mergeDirectives(...sets) {
  const out = emptyDirectives();
  for (const set of sets) for (const k of Object.keys(out)) out[k] = out[k] || Boolean(set?.[k]);
  return out;
}

// The index is CairnSearch's: a page fetched by another role only goes in when
// both that role and CairnSearch may access it, and CairnSearch-scoped
// noindex/nosnippet/noarchive (meta or X-Robots-Tag) apply too. Mirrors the
// crawler's canonical and content-hash dedupe. A page that is now noindex or
// disallowed is dropped from the index if it was there.
async function indexFetched(runtime, { role, url, ex, result, html }) {
  const { index, fetcher } = runtime;
  const drop = (outcome) => {
    if (index.has(url)) {
      index.remove(url);
      index.scheduleSave?.();
    }
    return outcome;
  };
  for (const r of role === 'search' ? ['search'] : [role, 'search']) {
    let check = null;
    try {
      check = await fetcher.checkRobots(url, r);
    } catch {
      check = null;
    }
    if (check?.allowed === true) continue;
    // A real rule against CairnSearch is an opt-out from the index (drop any old
    // copy); a synthetic disallow-all (robots.txt temporarily unreachable) or a
    // rule for the fetching role only blocks adding.
    return r === 'search' && check && !check.note ? drop('blocked-robots') : 'blocked-robots';
  }
  // Directives addressed to CairnSearch (or all robots), and the union with the fetching role's own.
  const searchTokens = robotsTokens('search');
  const forSearch =
    role === 'search'
      ? mergeDirectives(ex.metaRobots, result.xRobotsTag)
      : mergeDirectives(typeof html === 'string' ? metaDirectives(html, searchTokens) : null, parseXRobotsTag(result.headers?.['x-robots-tag'], searchTokens));
  const d = mergeDirectives(forSearch, ex.metaRobots, result.xRobotsTag);
  if (forSearch.noindex) return drop('noindex');
  if (d.noindex) return 'noindex';

  const canonical = ex.canonical ? normalizeUrl(ex.canonical, url) : null;
  if (canonical && canonical !== url && index.has(canonical)) return 'duplicate';
  const text = ex.text || '';
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
  const owner = index.findByHash?.(contentHash);
  if (owner && owner !== url && !index.has(url)) return 'duplicate';

  const outcome = index.add({
    url,
    title: ex.title || url,
    description: ex.description || '',
    text,
    markdown: ex.markdown || '',
    headings: ex.headings || [],
    lang: ex.lang || null,
    site: siteOf(url),
    fetchedAt: new Date().toISOString(),
    role,
    contentHash,
    canonical: canonical || null,
    noarchive: d.noarchive,
    nosnippet: d.nosnippet,
  });
  index.scheduleSave?.();
  return outcome;
}

// Fetch a page with a Cairn role, extract it, and optionally add it to the index.
export async function fetchAndExtract(runtime, { url, role = 'user', index = false, signal } = {}) {
  const target = requireUrl(url);
  requireRole(role);
  const { fetcher } = runtime;

  let robots;
  try {
    robots = await fetcher.checkRobots(target, role);
  } catch (err) {
    robots = { allowed: null, error: err.message };
  }

  const result = await fetcher.fetch(target, { role, signal });
  const { body, ...meta } = result;
  const finalUrl = normalizeUrl(result.finalUrl || '') || target;
  // A block on a redirect hop (maybe another origin) is described by that hop's decision.
  if (result.blocked?.reason === 'robots' && result.blocked.robots) robots = result.blocked.robots;

  let ex = null;
  let html = null;
  if (result.ok && typeof body === 'string') {
    const ct = String(result.contentType || '').toLowerCase();
    if (ct.includes('html') || ct.includes('xhtml')) {
      html = body;
      ex = extractHtml(body, finalUrl, { botTokens: robotsTokens(role) });
    } else if (ct.startsWith('text/')) ex = extractText(body, ct);
  }

  let extracted = null;
  if (ex) {
    const markdown = String(ex.markdown ?? ex.text ?? '');
    const links = Array.isArray(ex.links) ? ex.links : [];
    extracted = {
      title: ex.title || '',
      description: ex.description || '',
      lang: ex.lang || null,
      canonical: ex.canonical || null,
      markdown: markdown.slice(0, MAX_MARKDOWN),
      markdownTruncated: markdown.length > MAX_MARKDOWN,
      links: links.slice(0, MAX_LINKS),
      linkCount: links.length,
      metaRobots: ex.metaRobots || {},
      headings: ex.headings || [],
      wordCount: ex.wordCount || 0,
    };
  }

  let indexed = null;
  // Corpus-role fetches never feed the search index (independent opt-outs).
  if (index && ex && role !== 'corpus') indexed = await indexFetched(runtime, { role, url: finalUrl, ex, result, html });

  return { result: meta, extracted, indexed, robots };
}

// Aborts when the HTTP client goes away before the response is written, so a
// disconnected caller does not keep a fetch or a Claude run going.
function clientGone(res) {
  const ac = new AbortController();
  res?.on?.('close', () => {
    if (!res.writableFinished) ac.abort(new Error('client disconnected'));
  });
  return ac.signal;
}

// Each answer spawns a Claude CLI process (deep mode also an MCP server and live
// fetches); cap how many run at once per runtime.
export const MAX_CONCURRENT_ASKS = 4;
const activeAsks = new WeakMap();
export function acquireAskSlot(runtime) {
  const n = activeAsks.get(runtime) || 0;
  if (n >= MAX_CONCURRENT_ASKS) throw new HttpError(429, `Too many answers in progress (max ${MAX_CONCURRENT_ASKS}); try again shortly`);
  activeAsks.set(runtime, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeAsks.set(runtime, Math.max(0, (activeAsks.get(runtime) || 1) - 1));
  };
}

// Stored docs as shown to people: noarchive means no cached copy is displayed,
// nosnippet means no text beyond the title (see /bot).
export function docForDisplay(doc) {
  if (!doc || (!doc.noarchive && !doc.nosnippet)) return doc;
  const out = { ...doc, text: '', markdown: '', contentWithheld: doc.noarchive ? 'noarchive' : 'nosnippet' };
  if (doc.nosnippet) {
    out.description = '';
    out.headings = [];
  }
  return out;
}

// Robots decisions for every role (the requested role, if any, comes first).
export async function robotsDecisions(runtime, { url, role, robotsTxt } = {}) {
  if (role !== undefined && role !== null && role !== '') requireRole(role);
  const order = role ? [role, ...ROLE_IDS.filter((r) => r !== role)] : [...ROLE_IDS];

  if (typeof robotsTxt === 'string') {
    const absolute = typeof url === 'string' ? normalizeUrl(url) : null;
    const target = absolute ? pathWithQuery(absolute) : typeof url === 'string' && url.startsWith('/') ? url : null;
    if (!target) throw new HttpError(400, 'url must be an absolute http(s) URL or a path starting with /');
    const parsed = parseRobots(robotsTxt);
    const decisions = order.map((r) => {
      const tokens = robotsTokens(r);
      const d = parsed.isAllowed(tokens, target);
      return { role: r, token: ROLES[r].token, allowed: d.allowed, rule: d.rule ?? null, matchedAgent: d.matchedAgent ?? null, crawlDelay: parsed.crawlDelay(tokens) };
    });
    return {
      url: absolute || target,
      robotsUrl: absolute ? robotsUrlFor(absolute) : null,
      decisions,
      crawlDelay: decisions[0].crawlDelay,
      sitemaps: parsed.sitemaps || [],
      source: 'provided',
      status: null,
    };
  }

  const target = requireUrl(url);
  const decisions = [];
  let first = null;
  for (const r of order) {
    const c = await runtime.fetcher.checkRobots(target, r);
    first ??= c;
    decisions.push({ role: r, token: ROLES[r].token, allowed: c.allowed, rule: c.rule ?? null, matchedAgent: c.matchedAgent ?? null, crawlDelay: c.crawlDelay ?? null });
  }
  let sitemaps = [];
  try {
    const entry = await runtime.robots.get(target, order[0]);
    sitemaps = entry?.robots?.sitemaps || [];
  } catch {
    sitemaps = [];
  }
  return {
    url: target,
    robotsUrl: first.robotsUrl || robotsUrlFor(target),
    decisions,
    crawlDelay: first.crawlDelay ?? null,
    sitemaps,
    source: first.source ?? null,
    status: first.status ?? null,
  };
}

export function crawlOptions(body, config) {
  let raw = [];
  if (Array.isArray(body.seeds)) raw = body.seeds;
  else if (typeof body.seeds === 'string') raw = body.seeds.split(/[\s,]+/);
  else if (body.url) raw = [body.url];
  const seeds = [...new Set(raw.map((s) => normalizeUrl(String(s))).filter(Boolean))];
  if (!seeds.length) throw new HttpError(400, 'Provide at least one absolute http(s) seed URL (seeds or url)');
  if (seeds.length > 50) throw new HttpError(400, 'At most 50 seeds per job');

  const role = requireRole(body.role || 'search', ['search', 'corpus']);
  const opts = { seeds, role };
  if (body.maxPages !== undefined) opts.maxPages = clampInt(body.maxPages, config.crawl.maxPages, 1, 10000);
  if (body.maxDepth !== undefined) opts.maxDepth = clampInt(body.maxDepth, config.crawl.maxDepth, 0, 20);
  if (body.concurrency !== undefined) opts.concurrency = clampInt(body.concurrency, config.crawl.concurrency, 1, 32);
  const sameSiteOnly = optionalBool(body.sameSiteOnly);
  if (sameSiteOnly !== undefined) opts.sameSiteOnly = sameSiteOnly;
  const useSitemaps = optionalBool(body.useSitemaps);
  if (useSitemaps !== undefined) opts.useSitemaps = useSitemaps;
  for (const key of ['includePatterns', 'excludePatterns']) {
    let list = body[key];
    if (list === undefined || list === null || list === '') continue;
    if (typeof list === 'string') list = list.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(list)) throw new HttpError(400, `${key} must be an array of regular expressions`);
    for (const p of list) {
      try {
        new RegExp(String(p));
      } catch (err) {
        throw new HttpError(400, `Invalid ${key} entry "${p}": ${err.message}`);
      }
    }
    opts[key] = list.map(String);
  }
  return opts;
}

export async function ask(runtime, { question, mode = 'quick', model, apiUrl, onEvent, signal } = {}) {
  const q = typeof question === 'string' ? question.trim() : '';
  if (!q) throw new HttpError(400, 'question is required');
  if (q.length > 4000) throw new HttpError(400, 'question is too long (max 4000 characters)');
  if (!['quick', 'deep'].includes(mode)) throw new HttpError(400, "mode must be 'quick' or 'deep'");
  const m = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  if (mode === 'deep') {
    if (!apiUrl) throw new HttpError(500, 'Deep research needs a running Cairn server');
    return deepResearch(q, { runtime, apiUrl, onEvent, model: m, signal });
  }
  return answerQuestion(q, { runtime, onEvent, model: m, signal });
}

function findDoc(index, raw) {
  if (!raw) throw new HttpError(400, 'url query parameter is required');
  const candidates = [raw, normalizeUrl(raw)].filter(Boolean);
  for (const u of candidates) if (index.has(u)) return { url: u, doc: index.get(u) };
  return { url: candidates[candidates.length - 1], doc: null };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const routes = [];

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${source}$`), keys, handler });
}

function input(ctx) {
  return ctx.method === 'GET' ? Object.fromEntries(ctx.url.searchParams) : ctx.body || {};
}

route('GET', '/api/health', async ({ runtime }) => ({
  ok: true,
  name: 'Cairn',
  version: APP_VERSION,
  uptimeSec: uptimeSec(runtime),
  claude: await claudeStatus(runtime.config),
  // Optional UI pieces the dashboard links to only when installed.
  ui: {
    assistant: fs.existsSync(path.join(PROJECT_ROOT, 'web', 'bubble.html')),
    avatarGallery: fs.existsSync(path.join(PROJECT_ROOT, 'web', 'avatars', 'gallery.html')),
  },
}));

route('GET', '/api/identity', ({ runtime }) => identityInfo(runtime));

async function searchHandler(ctx) {
  const src = input(ctx);
  const q = String(src.q ?? src.query ?? '').trim();
  if (!q) throw new HttpError(400, 'Missing search query (q)');
  return ctx.runtime.index.search(q, {
    limit: clampInt(src.limit, 10, 1, 100),
    offset: clampInt(src.offset, 0, 0, 100000),
    site: src.site ? String(src.site) : undefined,
  });
}
route('GET', '/api/search', searchHandler);
route('POST', '/api/search', searchHandler);

route('POST', '/api/ask', async ({ runtime, state, body, res }) => {
  const release = acquireAskSlot(runtime);
  try {
    const { question, mode, model } = body || {};
    return await ask(runtime, { question, mode, model, apiUrl: state.url, signal: clientGone(res) });
  } finally {
    release();
  }
});

route('GET', '/api/ask/stream', async ({ req, res, runtime, state, url }) => {
  const params = Object.fromEntries(url.searchParams);
  const question = String(params.question || params.q || '').trim();
  if (!question) throw new HttpError(400, 'question is required');
  const mode = params.mode || 'quick';
  if (!['quick', 'deep'].includes(mode)) throw new HttpError(400, "mode must be 'quick' or 'deep'");

  const release = acquireAskSlot(runtime); // 429 as JSON, before the stream opens
  const sse = openSSE(req, res, { registry: state.sse });
  if (sse.closed) return release(); // refused (too many streams) or already gone
  const ac = new AbortController();
  sse.onClose(() => ac.abort());
  sse.send('status', { type: 'status', message: mode === 'deep' ? 'Starting deep research…' : 'Starting quick answer…', mode });
  try {
    const result = await ask(runtime, {
      question,
      mode,
      model: params.model,
      apiUrl: state.url,
      signal: ac.signal,
      onEvent: (ev) => {
        if (!ev || ev.type === 'result') return;
        sse.send(ASK_EVENT_TYPES.has(ev.type) ? ev.type : 'status', ev);
      },
    });
    sse.send('answer', result);
  } catch (err) {
    sse.send('error', { error: err.message });
  } finally {
    release();
  }
  sse.send('done', {});
  sse.close();
});

route('POST', '/api/crawl', (ctx) => {
  const job = ctx.runtime.jobs.create(crawlOptions(ctx.body || {}, ctx.runtime.config));
  ctx.status = 201;
  return { job: job.status() };
});

route('GET', '/api/crawl', ({ runtime }) => ({ jobs: runtime.jobs.list() }));

function getJob(runtime, id) {
  const job = runtime.jobs.get(id);
  if (!job) throw new HttpError(404, `No crawl job ${id}`);
  return job;
}

route('GET', '/api/crawl/:id', ({ runtime, params }) => getJob(runtime, params.id).status());

route('POST', '/api/crawl/:id/cancel', ({ runtime, params }) => {
  const job = getJob(runtime, params.id);
  runtime.jobs.cancel(params.id);
  return { job: job.status() };
});

route('GET', '/api/crawl/:id/events', ({ req, res, runtime, state, params }) => {
  const job = getJob(runtime, params.id);
  const sse = openSSE(req, res, { registry: state.sse });
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    sse.send('done', status || job.status());
    sse.close();
  };
  const initial = job.status();
  sse.send('state', initial);
  if (TERMINAL_JOB_STATES.has(initial.state)) return finish(initial);

  const onPage = (p) => sse.send('page', p);
  const onState = (s) => {
    sse.send('state', s);
    if (s && TERMINAL_JOB_STATES.has(s.state)) setImmediate(() => finish(job.status()));
  };
  const onDone = (s) => finish(s);
  job.on('page', onPage);
  job.on('state', onState);
  job.on('done', onDone);
  sse.onClose(() => {
    job.off('page', onPage);
    job.off('state', onState);
    job.off('done', onDone);
  });
});

route('POST', '/api/fetch', ({ runtime, body, res }) =>
  fetchAndExtract(runtime, { url: body.url, role: body.role || 'user', index: optionalBool(body.index) === true, signal: clientGone(res) }),
);

route('POST', '/api/robots/check', ({ runtime, body }) =>
  robotsDecisions(runtime, { url: body.url, role: body.role || undefined, robotsTxt: typeof body.robotsTxt === 'string' && body.robotsTxt.trim() ? body.robotsTxt : undefined }),
);

route('GET', '/api/robots/cache', ({ runtime }) => ({ entries: runtime.robots.entries() }));

route('POST', '/api/robots/cache/clear', ({ runtime }) => {
  const cleared = runtime.robots.entries().length;
  runtime.robots.clear();
  return { ok: true, cleared };
});

route('GET', '/api/index', ({ runtime, url }) => {
  const q = url.searchParams;
  return {
    stats: runtime.index.stats(),
    ...runtime.index.list({
      site: q.get('site') || undefined,
      limit: clampInt(q.get('limit'), 50, 1, 1000),
      offset: clampInt(q.get('offset'), 0, 0, 1e7),
    }),
  };
});

route('GET', '/api/index/doc', ({ runtime, url }) => {
  const { doc, url: key } = findDoc(runtime.index, url.searchParams.get('url'));
  if (!doc) throw new HttpError(404, `Not in index: ${key}`);
  return docForDisplay(doc);
});

route('DELETE', '/api/index/doc', async ({ runtime, url, body }) => {
  const { doc, url: key } = findDoc(runtime.index, url.searchParams.get('url') || body?.url);
  if (!doc) throw new HttpError(404, `Not in index: ${key}`);
  runtime.index.remove(key);
  runtime.index.scheduleSave?.();
  return { ok: true, removed: key };
});

route('POST', '/api/index/clear', async ({ runtime }) => {
  const before = runtime.index.stats().docs;
  runtime.index.clear();
  await runtime.index.save();
  return { ok: true, removed: before };
});

route('GET', '/api/audit', ({ runtime, url }) => {
  const q = url.searchParams;
  const sinceId = q.get('sinceId');
  return {
    entries: runtime.audit.recent({
      limit: clampInt(q.get('limit'), 100, 1, 5000),
      role: q.get('role') || undefined,
      kind: q.get('kind') || undefined,
      host: q.get('host') || undefined,
      sinceId: sinceId !== null && sinceId !== '' ? Number(sinceId) : undefined,
    }),
    stats: runtime.audit.stats(),
  };
});

route('GET', '/api/audit/stream', ({ req, res, runtime, state, url }) => {
  const role = url.searchParams.get('role');
  const kind = url.searchParams.get('kind');
  const sse = openSSE(req, res, { registry: state.sse });
  sse.comment('audit stream open');
  const unsubscribe = runtime.audit.subscribe((entry) => {
    if (role && entry.role !== role) return;
    if (kind && entry.kind !== kind) return;
    sse.send('entry', entry, { id: entry.id });
  });
  sse.onClose(unsubscribe);
});

route('GET', '/api/stats', ({ runtime }) => statsInfo(runtime));

route('GET', '/api/config', ({ runtime }) => configSubset(runtime.config));
route('POST', '/api/config', ({ runtime, body }) => updateConfig(runtime, body));

route('POST', '/api/verify-signature', ({ runtime, body }) => {
  let target;
  try {
    target = new URL(String(body.url)).toString();
  } catch {
    throw new HttpError(400, 'url must be an absolute URL');
  }
  if (!isPlainObject(body.headers)) throw new HttpError(400, 'headers must be an object of request headers');
  const headers = Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return verifyRequest({ method: String(body.method || 'GET').toUpperCase(), url: target, headers }, runtime.signer.jwks());
});

route('POST', '/api/sign-preview', ({ runtime, body }) => {
  const target = requireUrl(body.url);
  const role = requireRole(body.role || 'user');
  const { config, signer } = runtime;
  const signature = signer.signRequest({ method: 'GET', url: target });
  return {
    url: target,
    role,
    token: ROLES[role].token,
    headers: {
      'User-Agent': userAgent(role, config.publicBaseUrl),
      Accept: DEFAULT_ACCEPT,
      'Accept-Language': 'en',
      From: config.contact,
      ...signature,
    },
    signed: Object.keys(signature).length > 0,
    keyId: signer.keyId,
    jwksUrl: `${config.publicBaseUrl}${JWKS_PATH}`,
  };
});

// Returns true when the request was routed (response sent or streaming).
export async function handleApi(ctx) {
  const pathname = ctx.url.pathname.replace(/\/+$/, '') || '/';
  // The desktop assistant owns /api/assistant and everything below it. app.js
  // has already applied the guards and parsed the body (ctx.body).
  if (pathname === ASSISTANT_PREFIX || pathname.startsWith(`${ASSISTANT_PREFIX}/`)) {
    if (ctx.state?.assistant === false) {
      sendJson(ctx.res, 503, { error: 'The assistant is not enabled on this server (start it with `node bin/cairn.js serve`)' });
      return true;
    }
    return handleAssistantApi(ctx);
  }
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== ctx.method) continue;
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.handler(ctx);
    if (out !== undefined && !ctx.res.headersSent) sendJson(ctx.res, ctx.status || 200, out);
    return true;
  }
  if (pathMatched) {
    const allowed = [...new Set(routes.filter((r) => r.re.test(pathname)).map((r) => r.method))].join(', ');
    sendJson(ctx.res, 405, { error: `Method ${ctx.method} not allowed` }, { Allow: allowed });
    return true;
  }
  return false;
}
