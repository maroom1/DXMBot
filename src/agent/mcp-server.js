#!/usr/bin/env node
// Cairn MCP server (stdio, JSON-RPC 2.0, newline-delimited). Exposes Cairn's
// compliant retrieval stack to the Claude CLI research agent by proxying to the
// running Cairn HTTP API (CAIRN_API). stdout carries protocol only; logs go to stderr.
//
// Env: CAIRN_API (required, e.g. http://127.0.0.1:8787), CAIRN_SOURCES_FILE (JSON
// [{n,url,title}] rewritten after every change), CAIRN_ALLOW_LIVE_FETCH ('0' hides
// fetch_page/crawl_site), CAIRN_MCP_POLL_MS / CAIRN_MCP_CRAWL_WAIT_MS (crawl polling).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalizeUrl } from '../util/url.js';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_MARKDOWN_CHARS = 12_000;
const API = (process.env.CAIRN_API || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SOURCES_FILE = process.env.CAIRN_SOURCES_FILE || null;
const ALLOW_LIVE_FETCH = process.env.CAIRN_ALLOW_LIVE_FETCH !== '0';
const POLL_MS = Number(process.env.CAIRN_MCP_POLL_MS || 1000);
const CRAWL_WAIT_MS = Number(process.env.CAIRN_MCP_CRAWL_WAIT_MS || 90_000);

const log = (...args) => process.stderr.write(`[cairn-mcp] ${args.join(' ')}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// ---- source registry: every URL surfaced to the model gets a stable [n] ----
const sources = [];
const sourceByKey = new Map();

function registerSource(url, title) {
  if (!url) return null;
  const key = normalizeUrl(url) || url;
  let src = sourceByKey.get(key);
  let changed = false;
  if (!src) {
    src = { n: sources.length + 1, url: key, title: title || '' };
    sources.push(src);
    sourceByKey.set(key, src);
    changed = true;
  } else if (title && !src.title) {
    src.title = title;
    changed = true;
  }
  if (changed) writeSources();
  return src;
}

function writeSources() {
  if (!SOURCES_FILE) return;
  try {
    const tmp = path.join(path.dirname(SOURCES_FILE), `.${path.basename(SOURCES_FILE)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(sources.map((s) => ({ n: s.n, url: s.url, title: s.title || s.url })), null, 2));
    fs.renameSync(tmp, SOURCES_FILE);
  } catch (e) {
    log('failed to write sources file:', e.message);
  }
}

// ---- Cairn HTTP API client ----
class ApiError extends Error {}

async function api(method, route, body, timeoutMs = 60_000) {
  let res;
  try {
    res = await fetch(API + route, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ApiError(`Cairn API unreachable at ${API} (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(`Cairn API ${method} ${route} failed: HTTP ${res.status}${data?.error ? ` — ${data.error}` : ''}`);
  return data ?? {};
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const requireUrl = (args) => {
  const url = normalizeUrl(String(args?.url ?? '').trim());
  if (!url) throw new ApiError('A valid absolute http(s) "url" argument is required.');
  return url;
};

// ---- tools ----
const TOOLS = [
  {
    name: 'search_index',
    title: 'Search the Cairn index',
    description: 'Full-text (BM25) search over pages already crawled into the local Cairn index. Returns titles, URLs, snippets and a stable source id [n] for each hit. Start here.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 8)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    live: false,
    handler: searchIndex,
  },
  {
    name: 'fetch_page',
    title: 'Fetch a web page (robots.txt respected)',
    description: 'Fetch one URL as the Cairn-User bot (honest user agent, robots.txt respected) and add it to the index. Returns the page title and Markdown text with a source id [n], or a refusal if robots.txt disallows it.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    live: true,
    handler: fetchPage,
  },
  {
    name: 'crawl_site',
    title: 'Crawl a small part of a site',
    description: 'Run a small, polite search-index crawl from a seed URL (same site, robots.txt respected, max 25 pages, depth ≤ 2), wait for it to finish (≤ 90 s) and list the pages indexed with source ids.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Seed URL' },
        maxPages: { type: 'integer', minimum: 1, maximum: 25, description: 'Page budget (default 10, max 25)' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 2, description: 'Link depth (default 1, max 2)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    live: true,
    handler: crawlSite,
  },
  {
    name: 'check_robots',
    title: 'Check robots.txt rules',
    description: "Report whether each Cairn role (CairnSearch, CairnCorpus, Cairn-User) may fetch a URL under the site's robots.txt, with the matching rule.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        role: { type: 'string', enum: ['search', 'corpus', 'user'], description: 'Role to highlight (default user)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    live: false,
    handler: checkRobots,
  },
  {
    name: 'index_stats',
    title: 'Index statistics',
    description: 'Summary of the local Cairn index: document and passage counts and the sites it covers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    live: false,
    handler: indexStats,
  },
];

const activeTools = () => TOOLS.filter((t) => ALLOW_LIVE_FETCH || !t.live);

async function searchIndex(args) {
  const query = String(args?.query ?? '').trim();
  if (!query) throw new ApiError('"query" is required.');
  const limit = clampInt(args?.limit, 1, 20, 8);
  const data = await api('POST', '/api/search', { query, limit });
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) {
    return textResult(`No indexed pages match "${query}".${ALLOW_LIVE_FETCH ? ' Try fetch_page on a specific URL or crawl_site on a relevant site.' : ''}`);
  }
  const lines = [`${results.length} of ${data.total ?? results.length} indexed results for "${query}":`, ''];
  for (const r of results) {
    const src = registerSource(r.url, r.title);
    lines.push(`[${src.n}] ${r.title || '(untitled)'}`, `URL: ${src.url}`);
    if (r.snippet) lines.push(`Snippet: ${r.snippet}`);
    lines.push('');
  }
  lines.push('Cite these as [n]. Use fetch_page for the full text of a result.');
  return textResult(lines.join('\n'));
}

function describeRule(rule) {
  if (!rule) return 'no specific rule';
  return `${rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${rule.path}`;
}

async function fetchPage(args) {
  const url = requireUrl(args);
  const data = await api('POST', '/api/fetch', { url, role: 'user', index: true }, 90_000);
  const r = data.result || {};
  if (r.blocked) {
    const b = r.blocked;
    if (b.reason === 'robots') {
      // Prefer the decision for the hop that was actually blocked (a redirect
      // target may live on another origin with its own robots.txt).
      const d = b.robots || data.robots || {};
      const rule = b.rule || d.rule || null;
      const agent = d.matchedAgent ? ` (group "${d.matchedAgent}")` : '';
      const where = d.url && d.url !== url ? ` The request was redirected to ${d.url}, which is where it was blocked.` : '';
      // A synthetic disallow-all (robots.txt unreachable / 5xx / 429) is not the
      // owner's rule; say so, so the agent does not misreport the site's policy.
      let why;
      if (d.crawlDelayLimit) {
        why = `The site's robots.txt sets a Crawl-delay of ${d.crawlDelay} s, longer than Cairn will wait (${d.crawlDelayLimit} s), so Cairn treats it as disallowed.`;
      } else if (d.note && d.source !== 'stale') {
        why = `${d.note} Cairn does not fetch pages from a site whose robots.txt cannot be read (RFC 9309); try again later.`;
      } else {
        why = `The site's robots.txt disallows the Cairn-User bot here (${describeRule(rule)}${agent}).`;
      }
      return textResult(
        `BLOCKED BY ROBOTS.TXT — not fetched: ${url}\n` +
          `${why}${where} ` +
          'Cairn respects site owners\' choices: do not try to reach this content another way; use other sources or say it is unavailable.',
      );
    }
    return textResult(`Refused to fetch ${url}: ${b.reason}${b.detail ? ` — ${b.detail}` : ''}.`, true);
  }
  if (!r.ok) {
    const why = r.error || (r.status ? `HTTP ${r.status}` : 'unknown error');
    return textResult(`Fetch failed for ${url}: ${why}.`, true);
  }
  const ex = data.extracted;
  const finalUrl = r.finalUrl || r.url || url;
  const src = registerSource(finalUrl, ex?.title || '');
  const head = [`[${src.n}] ${ex?.title || '(untitled)'}`, `URL: ${src.url}`, `Status: ${r.status}${data.indexed ? ` · index: ${data.indexed}` : ''}`];
  if (!ex) {
    head.push('', `Fetched, but the content type (${r.contentType || 'unknown'}) could not be extracted as text.`);
    return textResult(head.join('\n'));
  }
  // nosnippet: the page's text may not be passed to the answer model (see /bot).
  if (ex.metaRobots?.nosnippet || r.xRobotsTag?.nosnippet) {
    head.push('', 'This page is marked nosnippet by its owner: its content is withheld and may not be quoted or summarised. You may cite it by title only.');
    return textResult(head.join('\n'));
  }
  let md = String(ex.markdown || '');
  if (md.length > MAX_MARKDOWN_CHARS) md = md.slice(0, MAX_MARKDOWN_CHARS) + `\n\n…(truncated at ${MAX_MARKDOWN_CHARS} characters)`;
  return textResult(`${head.join('\n')}\n\n${md || '(no text content)'}`);
}

const FINAL_STATES = new Set(['done', 'cancelled', 'error']);

async function crawlSite(args) {
  const url = requireUrl(args);
  const maxPages = clampInt(args?.maxPages, 1, 25, 10);
  const maxDepth = clampInt(args?.maxDepth, 0, 2, 1);
  const created = await api('POST', '/api/crawl', { seeds: [url], role: 'search', maxPages, maxDepth, sameSiteOnly: true });
  let status = created.job || created;
  if (!status?.id) throw new ApiError('Cairn API did not return a crawl job id.');
  const deadline = Date.now() + CRAWL_WAIT_MS;
  while (!FINAL_STATES.has(status.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const polled = await api('GET', `/api/crawl/${encodeURIComponent(status.id)}`);
    status = polled.job || polled;
  }
  const c = status.counts || {};
  const lines = [
    `Crawl ${status.id} from ${url}: ${FINAL_STATES.has(status.state) ? status.state : `still ${status.state} after ${Math.round(CRAWL_WAIT_MS / 1000)} s (partial results)`}.`,
    `fetched ${c.fetched ?? 0}, indexed ${c.indexed ?? 0}, blocked by robots.txt ${c.blockedRobots ?? 0}, noindex ${c.noindex ?? 0}, duplicates ${c.duplicates ?? 0}, errors ${c.errors ?? 0}.`,
  ];
  if (status.error) lines.push(`Error: ${status.error}`);
  const indexed = (status.recent || []).filter((p) => p.outcome === 'indexed');
  if (indexed.length) {
    lines.push('', 'Indexed pages (use search_index or fetch_page for their text):');
    for (const p of indexed) {
      const src = registerSource(p.url, p.title);
      lines.push(`[${src.n}] ${p.title || '(untitled)'} — ${src.url}`);
    }
  }
  const blocked = (status.recent || []).filter((p) => p.outcome === 'blocked-robots');
  if (blocked.length) lines.push('', `Skipped (robots.txt): ${blocked.map((p) => p.url).join(', ')}`);
  return textResult(lines.join('\n'));
}

async function checkRobots(args) {
  const url = requireUrl(args);
  const role = ['search', 'corpus', 'user'].includes(args?.role) ? args.role : 'user';
  const data = await api('POST', '/api/robots/check', { url, role });
  const lines = [`robots.txt decisions for ${data.url || url}${data.robotsUrl ? ` (from ${data.robotsUrl}, ${data.source || 'network'})` : ''}:`];
  for (const d of data.decisions || []) {
    const mark = d.role === role ? ' ←' : '';
    lines.push(`- ${d.token} (${d.role}): ${d.allowed ? 'ALLOWED' : 'DISALLOWED'} — ${describeRule(d.rule)}${d.matchedAgent ? `, group "${d.matchedAgent}"` : ''}${mark}`);
  }
  if (data.crawlDelay) lines.push(`Crawl-delay: ${data.crawlDelay} s`);
  if (data.sitemaps?.length) lines.push(`Sitemaps: ${data.sitemaps.join(', ')}`);
  return textResult(lines.join('\n'));
}

async function indexStats() {
  const data = await api('GET', '/api/stats');
  const s = data.index || {};
  const lines = [`Cairn index: ${s.docs ?? 0} docs, ${s.passages ?? 0} passages, ${s.terms ?? 0} terms${s.lastUpdated ? `, last updated ${s.lastUpdated}` : ''}.`];
  const sites = Array.isArray(s.sites) ? s.sites : [];
  if (sites.length) lines.push('Sites:', ...sites.slice(0, 30).map((x) => `- ${x.site}: ${x.docs} docs`));
  if (Array.isArray(data.jobs)) lines.push(`Crawl jobs: ${data.jobs.length}`);
  return textResult(lines.join('\n'));
}

// ---- JSON-RPC dispatch ----
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'cairn', version: '1.0.0' },
        instructions: 'Cairn web retrieval tools. All fetching is done by an honest, robots.txt-respecting bot; refusals must be respected. Cite sources with the [n] ids returned by tools.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: activeTools().map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case 'tools/call': {
      const tool = activeTools().find((t) => t.name === params?.name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
      try {
        return await tool.handler(params.arguments || {});
      } catch (e) {
        if (!(e instanceof ApiError)) log(`tool ${tool.name} crashed:`, e.stack || e.message);
        return textResult(`${tool.name} failed: ${e.message}`, true);
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Responses from the client (no method) are ignored; anything else malformed gets -32600.
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.method === undefined && ('result' in msg || 'error' in msg)) return null;
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isNotification = msg.id === undefined;
  if (isNotification) {
    if (msg.method !== 'notifications/initialized' && msg.method !== 'notifications/cancelled') log('ignoring notification', msg.method);
    return null;
  }
  try {
    const result = await dispatch(msg.method, msg.params);
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    if (!(e instanceof RpcError)) log('internal error:', e.stack || e.message);
    return { jsonrpc: '2.0', id: msg.id, error: { code, message: e.message } };
  }
}

const pending = new Set();

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

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const p = handleLine(line).catch((e) => log('unhandled:', e.stack || e.message));
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on('close', async () => {
  // Client went away: let in-flight calls finish briefly, then exit.
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 5000).unref())]);
  process.exit(0);
});
process.stdout.on('error', () => process.exit(0));
log(`ready (api ${API}${ALLOW_LIVE_FETCH ? '' : ', live fetch disabled'})`);
