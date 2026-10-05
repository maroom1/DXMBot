import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'mcp-server.js');

// Minimal stand-in for the Cairn HTTP API.
function startFakeApi() {
  const requests = [];
  let crawlPolls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
      const reply = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return reply(415, { error: 'json required' });
      if (req.method === 'POST' && req.url === '/api/search') {
        return reply(200, {
          query: json.query,
          total: 2,
          tookMs: 1,
          results: [
            { url: 'http://shop.test/products/ridgeback-45.html', title: 'Ridgeback 45', snippet: 'weighs 1.2 kg', score: 3, site: 'shop.test' },
            { url: 'http://shop.test/faq.html', title: 'FAQ', snippet: 'returns within 60 days', score: 2, site: 'shop.test' },
          ],
        });
      }
      if (req.method === 'POST' && req.url === '/api/fetch') {
        if (json.url.includes('down.test')) {
          // robots.txt unreachable: RobotsCache serves a synthetic disallow-all with a note.
          return reply(200, {
            result: { ok: false, url: json.url, finalUrl: json.url, status: null, blocked: { reason: 'robots', detail: 'Disallowed by robots.txt', rule: { type: 'disallow', path: '/' } } },
            extracted: null,
            indexed: null,
            robots: { allowed: false, rule: { type: 'disallow', path: '/' }, matchedAgent: '*', status: 0, source: 'network', note: 'robots.txt unreachable (network error); treated as disallow-all.' },
          });
        }
        if (json.url.includes('/private/')) {
          return reply(200, {
            result: { ok: false, url: json.url, finalUrl: json.url, status: null, blocked: { reason: 'robots', detail: 'Disallowed by robots.txt', rule: { type: 'disallow', path: '/private/' } } },
            extracted: null,
            indexed: null,
            robots: { allowed: false, rule: { type: 'disallow', path: '/private/' }, matchedAgent: '*' },
          });
        }
        if (json.url.includes('/nosnippet')) {
          return reply(200, {
            result: { ok: true, url: json.url, finalUrl: json.url, status: 200, blocked: null, contentType: 'text/html', xRobotsTag: { nosnippet: true } },
            extracted: { title: 'Members lounge', markdown: 'SECRET-BODY-TEXT', metaRobots: {} },
            indexed: 'added',
            robots: { allowed: true },
          });
        }
        if (json.url.includes('/hop')) {
          // Requested URL allowed on its origin; the redirect target's origin has no readable robots.txt.
          return reply(200, {
            result: {
              ok: false, url: json.url, finalUrl: 'http://other.test/x', status: null,
              blocked: { reason: 'robots', detail: 'Disallowed', rule: null, robots: { url: 'http://other.test/x', allowed: false, rule: null, matchedAgent: null, source: 'network', note: 'robots.txt unreachable (HTTP 503); treated as disallow-all.' } },
            },
            extracted: null,
            indexed: null,
            robots: { allowed: true, rule: null, matchedAgent: '*', note: 'No robots.txt restrictions apply (allow all).', source: 'network' },
          });
        }
        if (json.url.includes('/missing')) {
          return reply(200, { result: { ok: false, url: json.url, status: 404, blocked: null, error: null }, extracted: null, indexed: null });
        }
        return reply(200, {
          result: { ok: true, url: json.url, finalUrl: json.url, status: 200, blocked: null, contentType: 'text/html' },
          extracted: { title: 'Ridgeback 45', markdown: '# Ridgeback 45\n\nWeighs 1.2 kg. ' + 'x'.repeat(20000) },
          indexed: 'added',
          robots: { allowed: true },
        });
      }
      if (req.method === 'POST' && req.url === '/api/crawl') {
        return reply(201, { job: { id: 'job-1-abc', state: 'running', counts: {}, recent: [] } });
      }
      if (req.method === 'GET' && req.url === '/api/crawl/job-1-abc') {
        crawlPolls++;
        if (crawlPolls < 2) return reply(200, { id: 'job-1-abc', state: 'running', counts: { fetched: 1 }, recent: [] });
        return reply(200, {
          id: 'job-1-abc',
          state: 'done',
          counts: { fetched: 3, indexed: 2, blockedRobots: 1, noindex: 0, duplicates: 0, errors: 0 },
          recent: [
            { url: 'http://shop.test/about.html', outcome: 'indexed', title: 'About', status: 200 },
            { url: 'http://shop.test/faq.html', outcome: 'indexed', title: 'FAQ', status: 200 },
            { url: 'http://shop.test/private/secret.html', outcome: 'blocked-robots', status: null },
          ],
        });
      }
      if (req.method === 'POST' && req.url === '/api/robots/check') {
        return reply(200, {
          url: json.url,
          robotsUrl: 'http://shop.test/robots.txt',
          source: 'network',
          decisions: [
            { role: 'search', token: 'CairnSearch', allowed: true, rule: null, matchedAgent: 'cairnsearch' },
            { role: 'corpus', token: 'CairnCorpus', allowed: false, rule: { type: 'disallow', path: '/' }, matchedAgent: 'cairncorpus' },
            { role: 'user', token: 'Cairn-User', allowed: true, rule: null, matchedAgent: '*' },
          ],
          crawlDelay: null,
          sitemaps: ['http://shop.test/sitemap.xml'],
        });
      }
      if (req.method === 'GET' && req.url === '/api/stats') {
        return reply(200, { index: { docs: 42, passages: 120, terms: 900, sites: [{ site: 'shop.test', docs: 42 }], lastUpdated: null }, jobs: [] });
      }
      reply(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

// Line-oriented JSON-RPC client over the server's stdio.
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.messages = [];
    this.waiters = [];
    this.stderr = '';
    this.rawLines = [];
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.rawLines.push(line);
        const msg = JSON.parse(line); // stdout must be pure protocol
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => !w(msg));
      }
    });
    this.child.stderr.on('data', (d) => (this.stderr += d));
    this.nextId = 1;
  }
  waitFor(pred, timeoutMs = 10000) {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; stderr: ${this.stderr}`)), timeoutMs);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        resolve(msg);
        return true;
      });
    });
  }
  writeRaw(line) {
    this.child.stdin.write(line + '\n');
  }
  request(method, params) {
    const id = this.nextId++;
    this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return this.waitFor((m) => m.id === id);
  }
  notify(method, params) {
    this.writeRaw(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
  call(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
  close() {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once('exit', resolve);
      this.child.stdin.end();
    });
  }
}

const readSources = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('mcp-server', () => {
  let api;
  let tmp;
  let sourcesFile;
  let client;

  before(async () => {
    api = await startFakeApi();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mcp-test-'));
    sourcesFile = path.join(tmp, 'sources.json');
    client = new McpClient({ CAIRN_API: api.url, CAIRN_SOURCES_FILE: sourcesFile, CAIRN_MCP_POLL_MS: '20' });
  });
  after(async () => {
    await client.close();
    api.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('initialize echoes the protocol version and advertises tools', async () => {
    const res = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.result.protocolVersion, '2025-03-26');
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.deepEqual(res.result.serverInfo, { name: 'cairn', version: '1.0.0' });
    client.notify('notifications/initialized');
    const dflt = await client.request('initialize', {});
    assert.equal(dflt.result.protocolVersion, '2025-06-18');
    const ping = await client.request('ping');
    assert.deepEqual(ping.result, {});
  });

  test('tools/list returns 5 tools with JSON-schema inputs', async () => {
    const res = await client.request('tools/list', {});
    const tools = res.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['check_robots', 'crawl_site', 'fetch_page', 'index_stats', 'search_index']);
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.inputSchema.properties, 'object');
    }
    assert.deepEqual(tools.find((t) => t.name === 'search_index').inputSchema.required, ['query']);
    assert.deepEqual(tools.find((t) => t.name === 'fetch_page').inputSchema.required, ['url']);
  });

  test('search_index proxies to /api/search and registers stable source ids', async () => {
    const res = await client.call('search_index', { query: 'ridgeback weight', limit: 5 });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.equal(res.result.content[0].type, 'text');
    assert.match(text, /\[1\] Ridgeback 45/);
    assert.match(text, /\[2\] FAQ/);
    assert.match(text, /weighs 1\.2 kg/);
    const req = api.requests.find((r) => r.url === '/api/search');
    assert.deepEqual(req.body, { query: 'ridgeback weight', limit: 5 });
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(readSources(sourcesFile), [
      { n: 1, url: 'http://shop.test/products/ridgeback-45.html', title: 'Ridgeback 45' },
      { n: 2, url: 'http://shop.test/faq.html', title: 'FAQ' },
    ]);
  });

  test('fetch_page returns markdown (capped) and reuses the existing source id', async () => {
    const res = await client.call('fetch_page', { url: 'http://shop.test/products/ridgeback-45.html' });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /^\[1\] Ridgeback 45/);
    assert.match(text, /Weighs 1\.2 kg/);
    assert.match(text, /truncated at 12000/);
    assert.ok(text.length < 12_500);
    const req = api.requests.find((r) => r.url === '/api/fetch');
    assert.deepEqual(req.body, { url: 'http://shop.test/products/ridgeback-45.html', role: 'user', index: true });
    assert.equal(readSources(sourcesFile).length, 2);
  });

  test('fetch_page on a robots-blocked URL returns a clear refusal (not an error)', async () => {
    const res = await client.call('fetch_page', { url: 'http://shop.test/private/secret.html' });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /BLOCKED BY ROBOTS\.TXT/);
    assert.match(text, /Disallow: \/private\//);
    assert.match(text, /do not try/i);
    assert.equal(readSources(sourcesFile).length, 2, 'blocked URLs are not sources');
  });

  test('fetch_page explains a block caused by an unreachable robots.txt', async () => {
    const res = await client.call('fetch_page', { url: 'http://down.test/page.html' });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /BLOCKED BY ROBOTS\.TXT/);
    assert.match(text, /robots\.txt unreachable/);
    assert.doesNotMatch(text, /robots\.txt disallows/, 'must not claim the owner wrote a rule');
    assert.match(text, /do not try/i);
  });

  test('fetch_page HTTP failure and invalid URL are tool errors', async () => {
    const missing = await client.call('fetch_page', { url: 'http://shop.test/missing' });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /HTTP 404/);
    const bad = await client.call('fetch_page', { url: 'ftp://nope' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /valid absolute http/);
  });

  test('crawl_site starts a job, polls to completion and registers indexed pages', async () => {
    const res = await client.call('crawl_site', { url: 'http://shop.test/', maxPages: 100, maxDepth: 5 });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /job-1-abc/);
    assert.match(text, /: done\./);
    assert.match(text, /\[3\] About/);
    assert.match(text, /\[2\] FAQ/, 'already-known URL keeps its id');
    assert.match(text, /Skipped \(robots\.txt\)/);
    const req = api.requests.find((r) => r.url === '/api/crawl');
    assert.equal(req.body.maxPages, 25, 'maxPages clamped');
    assert.equal(req.body.maxDepth, 2, 'maxDepth clamped');
    assert.deepEqual(req.body.seeds, ['http://shop.test/']);
    assert.deepEqual(readSources(sourcesFile).map((s) => s.n), [1, 2, 3]);
  });

  test('fetch_page withholds the body of nosnippet pages', async () => {
    const res = await client.call('fetch_page', { url: 'http://shop.test/nosnippet.html' });
    assert.equal(res.result.isError, false);
    const text = res.result.content[0].text;
    assert.match(text, /Members lounge/);
    assert.match(text, /nosnippet/);
    assert.doesNotMatch(text, /SECRET-BODY-TEXT/);
  });

  test('fetch_page explains a block on a redirect hop using that hop\'s decision', async () => {
    const res = await client.call('fetch_page', { url: 'http://shop.test/hop' });
    const text = res.result.content[0].text;
    assert.match(text, /BLOCKED BY ROBOTS\.TXT/);
    assert.match(text, /robots\.txt unreachable \(HTTP 503\)/);
    assert.match(text, /redirected to http:\/\/other\.test\/x/);
    assert.doesNotMatch(text, /allow all/);
  });

  test('check_robots and index_stats summarize API data', async () => {
    const robots = await client.call('check_robots', { url: 'http://shop.test/x', role: 'corpus' });
    const rt = robots.result.content[0].text;
    assert.match(rt, /CairnCorpus \(corpus\): DISALLOWED — Disallow: \/,.*←/);
    assert.match(rt, /Cairn-User \(user\): ALLOWED/);
    const stats = await client.call('index_stats', {});
    assert.match(stats.result.content[0].text, /42 docs/);
    assert.match(stats.result.content[0].text, /shop\.test: 42 docs/);
  });

  test('unknown method → -32601, unknown tool → -32602', async () => {
    const res = await client.request('resources/list', {});
    assert.equal(res.error.code, -32601);
    const tool = await client.call('rm_rf', {});
    assert.equal(tool.error.code, -32602);
  });

  test('malformed JSON → -32700 without crashing', async () => {
    client.writeRaw('{"jsonrpc": "2.0", "id": 99, "method": ');
    const err = await client.waitFor((m) => m.error?.code === -32700);
    assert.equal(err.id, null);
    client.writeRaw('{"id": 5}');
    const invalid = await client.waitFor((m) => m.error?.code === -32600);
    assert.equal(invalid.id, 5);
    const ping = await client.request('ping');
    assert.deepEqual(ping.result, {});
    assert.equal(client.child.exitCode, null);
    for (const line of client.rawLines) JSON.parse(line);
  });

  test('API unreachable → tool error result', async () => {
    const c = new McpClient({ CAIRN_API: 'http://127.0.0.1:9', CAIRN_SOURCES_FILE: path.join(tmp, 's2.json') });
    try {
      const res = await c.call('index_stats', {});
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /unreachable/);
    } finally {
      await c.close();
    }
  });

  test('CAIRN_ALLOW_LIVE_FETCH=0 hides fetch_page and crawl_site', async () => {
    const c = new McpClient({ CAIRN_API: api.url, CAIRN_ALLOW_LIVE_FETCH: '0' });
    try {
      const res = await c.request('tools/list', {});
      assert.deepEqual(res.result.tools.map((t) => t.name).sort(), ['check_robots', 'index_stats', 'search_index']);
      const call = await c.call('fetch_page', { url: 'http://shop.test/' });
      assert.equal(call.error.code, -32602);
    } finally {
      await c.close();
    }
  });
});
