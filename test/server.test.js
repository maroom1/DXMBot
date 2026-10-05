import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';
import { startServer, allowedOriginsFor, allowedHostsFor } from '../src/server/app.js';
import { userAgent } from '../src/identity.js';
import { deepMerge } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cairn.js');

let dataDir;
let runtime;
let srv;
let site;
let siteUrl;
let port;

const PAGES = {
  '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /private/\n\nUser-agent: CairnCorpus\nDisallow: /\n'],
  '/': ['text/html', '<!doctype html><html><head><title>Test Outfitters</title></head><body><h1>Test Outfitters</h1><p>Welcome to our small shop of outdoor equipment.</p><a href="/gear.html">Gear</a> <a href="/about.html">About</a> <a href="/private/secret.html">Secret</a></body></html>'],
  '/gear.html': ['text/html', '<!doctype html><html><head><title>Ridgeback backpack</title></head><body><h1>Ridgeback backpack</h1><p>The Ridgeback backpack weighs 1.2 kg and holds 45 litres of gear for long hikes.</p></body></html>'],
  '/about.html': ['text/html', '<!doctype html><html><head><title>About us</title></head><body><h1>About</h1><p>We are a company in Boise founded in 2011 that makes durable trail equipment.</p></body></html>'],
  '/private/secret.html': ['text/html', '<html><body>top secret</body></html>'],
};

function startSite() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    requests.push(p);
    const page = PAGES[p];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': `${page[0]}; charset=utf-8` });
    res.end(page[1]);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

// Raw node:http client so tests can set Host/Origin/Content-Type freely.
function request(method, urlPath, { headers = {}, body, json } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : body;
    const h = { ...headers };
    if (json !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const get = (p, opts) => request('GET', p, opts);
const post = (p, json, opts = {}) => request('POST', p, { ...opts, json });

// Opens an SSE stream and resolves with the first event named `eventName`.
function waitForSseEvent(urlPath, eventName, { onOpen, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    // Non-browser clients identify themselves for side-effecting GET streams.
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: { 'X-Cairn-Client': 'test' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (event === eventName) {
            clearTimeout(timer);
            req.destroy();
            resolve(data ? JSON.parse(data) : null);
          }
        }
      });
      onOpen?.();
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out waiting for SSE event ${eventName}`));
    }, timeoutMs);
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-server-test-'));
  runtime = await createRuntime({ dataDir, port: 0, politeness: { minDelayMs: 0 } });
  // Keep answering deterministic and offline: no real Claude CLI in these tests.
  runtime.config.agent.claudeBin = path.join(dataDir, 'no-such-claude');
  srv = await startServer({ runtime, port: 0 });
  port = srv.port;
  site = await startSite();
  siteUrl = site.url;
});

after(async () => {
  await srv?.close();
  await runtime?.close();
  await new Promise((r) => site?.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('server binds loopback and rewrites publicBaseUrl', () => {
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(runtime.config.publicBaseUrl, srv.url);
});

test('GET /api/health', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.name, 'Cairn');
  assert.equal(typeof r.json.version, 'string');
  assert.equal(typeof r.json.uptimeSec, 'number');
  assert.equal(typeof r.json.claude.available, 'boolean');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('GET /api/identity lists all three roles with full user agents', async () => {
  const r = await get('/api/identity');
  assert.equal(r.status, 200);
  const tokens = r.json.roles.map((x) => x.token);
  assert.deepEqual(tokens.sort(), ['Cairn-User', 'CairnCorpus', 'CairnSearch']);
  const search = r.json.roles.find((x) => x.id === 'search');
  assert.ok(search.userAgent.includes('CairnSearch/1.0'));
  assert.ok(search.userAgent.includes(`+${srv.url}/bot`));
  assert.equal(r.json.familyToken, 'Cairn');
  assert.equal(r.json.keyId, runtime.signer.keyId);
  assert.equal(r.json.jwksUrl, `${srv.url}/.well-known/http-message-signatures-directory`);
  assert.equal(r.json.botPageUrl, `${srv.url}/bot`);
});

test('GET /bot is a site-owner HTML page naming every token', async () => {
  const r = await get('/bot');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  for (const t of ['CairnSearch', 'CairnCorpus', 'Cairn-User']) assert.ok(r.text.includes(t), `missing ${t}`);
  assert.ok(r.text.includes('/.well-known/http-message-signatures-directory'));
  assert.ok(r.text.includes(runtime.signer.keyId));
  assert.ok(r.text.includes('/bot/cairnsearch.json'));
  assert.ok(r.text.includes('/docs/assets/docs.css'));
  assert.ok(r.text.includes('Disallow: /'));
  assert.ok(!r.text.includes('<script'), 'bot page should need no scripts');
});

test('Web Bot Auth key directory has the right media type', async () => {
  const r = await get('/.well-known/http-message-signatures-directory');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/http-message-signatures-directory+json');
  assert.equal(r.json.keys[0].kid, runtime.signer.keyId);
  assert.equal(r.json.keys[0].crv, 'Ed25519');
});

test('IP range JSON files', async () => {
  for (const f of ['cairnsearch.json', 'cairncorpus.json', 'cairn-user.json']) {
    const r = await get(`/bot/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(typeof r.json.creationTime, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.json.creationTime)));
    assert.deepEqual(r.json.prefixes, [{ ipv4Prefix: '127.0.0.1/32' }, { ipv6Prefix: '::1/128' }]);
  }
});

test('search on an empty index and parameter validation', async () => {
  const r = await get('/api/search?q=anything');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 0);
  assert.deepEqual(r.json.results, []);
  const bad = await get('/api/search');
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);
});

test('robots/check with a pasted robots.txt evaluates every role', async () => {
  const r = await post('/api/robots/check', {
    url: 'https://example.com/private/page.html',
    robotsTxt: 'User-agent: CairnSearch\nDisallow: /private/\n\nUser-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'provided');
  const byRole = Object.fromEntries(r.json.decisions.map((d) => [d.role, d]));
  assert.equal(byRole.search.allowed, false);
  assert.equal(byRole.search.rule.path, '/private/');
  assert.equal(byRole.corpus.allowed, true);
  assert.equal(byRole.user.allowed, true);
  assert.deepEqual(r.json.sitemaps, ['https://example.com/sitemap.xml']);

  const focused = await post('/api/robots/check', { url: 'https://example.com/private/x', role: 'corpus', robotsTxt: 'User-agent: CairnCorpus\nDisallow: /\n' });
  assert.equal(focused.json.decisions[0].role, 'corpus');
  assert.equal(focused.json.decisions[0].allowed, false);
});

test('robots/check against a live site uses the fetcher', async () => {
  const r = await post('/api/robots/check', { url: `${siteUrl}/private/secret.html` });
  assert.equal(r.status, 200);
  assert.equal(r.json.robotsUrl, `${siteUrl}/robots.txt`);
  const byRole = Object.fromEntries(r.json.decisions.map((d) => [d.role, d]));
  assert.equal(byRole.search.allowed, false);
  assert.equal(byRole.corpus.allowed, false);
  const cache = await get('/api/robots/cache');
  assert.ok(cache.json.entries.length >= 1);
});

test('POST /api/fetch returns extracted markdown and respects robots', async () => {
  const r = await post('/api/fetch', { url: `${siteUrl}/gear.html` });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.status, 200);
  assert.equal(r.json.result.body, undefined, 'body must be stripped');
  assert.equal(r.json.result.role, 'user');
  assert.ok(r.json.extracted.markdown.includes('Ridgeback'));
  assert.equal(r.json.extracted.title, 'Ridgeback backpack');
  assert.equal(r.json.robots.allowed, true);
  assert.equal(r.json.indexed, null);

  const blocked = await post('/api/fetch', { url: `${siteUrl}/private/secret.html` });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.result.blocked?.reason, 'robots');
  assert.equal(blocked.json.extracted, null);
  assert.ok(!site.requests.includes('/private/secret.html'));

  const invalid = await post('/api/fetch', { url: 'ftp://example.com/' });
  assert.equal(invalid.status, 400);
});

test('crawl job runs to completion and feeds search', async () => {
  const created = await post('/api/crawl', { url: `${siteUrl}/`, maxPages: 10, maxDepth: 2, useSitemaps: false });
  assert.equal(created.status, 201);
  const id = created.json.job.id;
  assert.ok(id);
  assert.equal(created.json.job.role, 'search');

  let status;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    status = (await get(`/api/crawl/${id}`)).json;
    if (['done', 'cancelled', 'error'].includes(status.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.state, 'done');
  assert.ok(status.counts.indexed >= 2, `indexed ${status.counts.indexed}`);
  assert.ok(!site.requests.includes('/private/secret.html'), 'robots-disallowed page was requested');

  const list = await get('/api/crawl');
  assert.ok(list.json.jobs.some((j) => j.id === id));

  const events = await waitForSseEvent(`/api/crawl/${id}/events`, 'done');
  assert.equal(events.id, id);

  const s = await post('/api/search', { q: 'ridgeback backpack weight' });
  assert.equal(s.status, 200);
  assert.ok(s.json.results.length >= 1);
  assert.equal(s.json.results[0].url, `${siteUrl}/gear.html`);

  const idx = await get('/api/index');
  assert.ok(idx.json.stats.docs >= 2);
  assert.ok(Array.isArray(idx.json.docs));
  const doc = await get(`/api/index/doc?url=${encodeURIComponent(`${siteUrl}/gear.html`)}`);
  assert.equal(doc.status, 200);
  assert.equal(doc.json.url, `${siteUrl}/gear.html`);

  const stats = await get('/api/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.index.docs >= 2);
  assert.ok(Array.isArray(stats.json.hosts));
  assert.ok(Array.isArray(stats.json.jobs));
  assert.equal(typeof stats.json.robotsCache, 'number');

  const badRole = await post('/api/crawl', { url: `${siteUrl}/`, role: 'user' });
  assert.equal(badRole.status, 400);
  const unknown = await get('/api/crawl/job-does-not-exist');
  assert.equal(unknown.status, 404);
});

test('ask (quick) falls back to an extractive answer with citations', async () => {
  const r = await post('/api/ask', { question: 'How much does the Ridgeback backpack weigh?' });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'quick');
  assert.equal(r.json.usedClaude, false);
  assert.ok(r.json.citations.length >= 1);

  const answer = await waitForSseEvent(`/api/ask/stream?question=${encodeURIComponent('Ridgeback backpack weight')}`, 'answer');
  assert.equal(answer.mode, 'quick');

  const bad = await post('/api/ask', { question: '' });
  assert.equal(bad.status, 400);
});

test('index doc delete requires JSON content type and removes the doc', async () => {
  const target = encodeURIComponent(`${siteUrl}/about.html`);
  const noType = await request('DELETE', `/api/index/doc?url=${target}`);
  assert.equal(noType.status, 415);
  const del = await request('DELETE', `/api/index/doc?url=${target}`, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(del.status, 200);
  const gone = await get(`/api/index/doc?url=${target}`);
  assert.equal(gone.status, 404);
});

test('CSRF guards: JSON content type (415) and same Origin (403)', async () => {
  const textPlain = await request('POST', '/api/search', { headers: { 'Content-Type': 'text/plain' }, body: '{"q":"x"}' });
  assert.equal(textPlain.status, 415);
  const form = await request('POST', '/api/config', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'crawl=1' });
  assert.equal(form.status, 415);
  const evil = await post('/api/search', { q: 'x' }, { headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  const sameOrigin = await post('/api/search', { q: 'x' }, { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameOrigin.status, 200);
  const badJson = await request('POST', '/api/search', { headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
});

test('cross-site GETs to side-effecting API routes are rejected (403)', async () => {
  const q = '/api/ask/stream?question=x&mode=deep';
  const crossSite = await request('GET', q, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const sameSite = await request('GET', q, { headers: { 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(sameSite.status, 403);
  const foreignOrigin = await request('GET', q, { headers: { Origin: 'http://evil.example' } });
  assert.equal(foreignOrigin.status, 403);
  const sameOrigin = await request('GET', '/api/health', { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameOrigin.status, 200);
  // Public, non-API resources stay reachable from anywhere.
  const bot = await request('GET', '/bot', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(bot.status, 200);
});

test('GET /api/ask/stream needs same-origin proof (old browsers send no Fetch Metadata)', async () => {
  const q = '/api/ask/stream?question=x';
  const bare = await request('GET', q); // e.g. <img src> in a browser without Sec-Fetch-*
  assert.equal(bare.status, 403);
  const page = await request('GET', '/bot');
  const cookie = String(page.headers['set-cookie']?.[0] || '').split(';')[0];
  assert.match(cookie, /^cairn_ui=[0-9a-f]{32}$/);
  assert.match(String(page.headers['set-cookie'][0]), /SameSite=Strict/);
  const withCookie = await request('GET', `${q}&mode=bogus`, { headers: { Cookie: cookie } });
  assert.equal(withCookie.status, 400, 'passes the guard (then fails validation)');
  const wrongCookie = await request('GET', `${q}&mode=bogus`, { headers: { Cookie: 'cairn_ui=nope' } });
  assert.equal(wrongCookie.status, 403);
  const sameOrigin = await request('GET', `${q}&mode=bogus`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(sameOrigin.status, 400);
  const client = await request('GET', `${q}&mode=bogus`, { headers: { 'X-Cairn-Client': 'cli' } });
  assert.equal(client.status, 400);
});

test("Cairn's own bots cannot call the API (self-fetch loop), but may read public pages", async () => {
  const ua = userAgent('user', srv.url);
  const api = await request('GET', '/api/config', { headers: { 'User-Agent': ua } });
  assert.equal(api.status, 403);
  const viaFetcher = await runtime.fetcher.fetch(`${srv.url}/api/config`, { role: 'user', respectRobots: false });
  assert.equal(viaFetcher.status, 403);
  const bot = await request('GET', '/bot', { headers: { 'User-Agent': ua } });
  assert.equal(bot.status, 200);
});

test('unexpected 500s do not leak internal error messages', async () => {
  const saved = runtime.index.stats;
  runtime.index.stats = () => {
    throw new Error('EACCES: permission denied, open /secret/path/index.json');
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await get('/api/stats');
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'Internal server error');
    assert.match(r.json.id, /^[0-9a-f]{12}$/);
    assert.doesNotMatch(r.text, /secret\/path/);
  } finally {
    runtime.index.stats = saved;
    console.error = orig;
  }
});

test('allowedOriginsFor accepts the explicit https public origin', () => {
  const config = { publicBaseUrl: 'https://cairn.example.com', publicBaseUrlExplicit: true };
  const origins = allowedOriginsFor(allowedHostsFor('127.0.0.1', 8787, config), config);
  assert.ok(origins.has('https://cairn.example.com'));
  assert.ok(origins.has('http://127.0.0.1:8787'));
  assert.ok(origins.has('http://localhost:8787'));
  assert.equal(origins.has('http://evil.example'), false);
});

test('Host guard rejects DNS-rebinding style requests with 421', async () => {
  const r = await get('/api/health', { headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 421);
  const ok = await get('/api/health', { headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});

test('bodies over 1 MB are rejected with 413', async () => {
  const big = JSON.stringify({ q: 'x'.repeat(1024 * 1024 + 10) });
  const r = await request('POST', '/api/search', { headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(r.status, 413);
});

test('unknown routes return 404 JSON; wrong method 405', async () => {
  const api = await get('/api/definitely-not-here');
  assert.equal(api.status, 404);
  assert.ok(api.json.error);
  const page = await get('/nope.html');
  assert.equal(page.status, 404);
  const method = await request('DELETE', '/api/health', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(method.status, 405);
});

test('audit log lists entries and the SSE stream delivers new ones', async () => {
  const r = await get('/api/audit?limit=5');
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.length >= 1);
  assert.ok(r.json.entries.length <= 5);
  assert.equal(typeof r.json.stats.total, 'number');
  const fetches = await get('/api/audit?kind=fetch&limit=50');
  assert.ok(fetches.json.entries.every((e) => e.kind === 'fetch'));

  const entry = await waitForSseEvent('/api/audit/stream', 'entry', {
    onOpen: () => setTimeout(() => runtime.audit.record({ kind: 'system', message: 'sse-test' }), 50),
  });
  assert.equal(entry.message, 'sse-test');
});

test('config GET/POST roundtrip persists editable keys', async () => {
  const before = await get('/api/config');
  assert.equal(before.status, 200);
  assert.equal(typeof before.json.politeness.minDelayMs, 'number');
  assert.equal(before.json.dataDir, undefined, 'only editable keys are exposed');

  const updated = await post('/api/config', { crawl: { maxPages: 7 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.crawl.maxPages, 7);
  const after = await get('/api/config');
  assert.equal(after.json.crawl.maxPages, 7);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.crawl.maxPages, 7);

  assert.equal((await post('/api/config', { crawl: { maxPages: 'lots' } })).status, 400);
  assert.equal((await post('/api/config', { port: 1 })).status, 400);
  assert.equal((await post('/api/config', { agent: { claudeBin: '/bin/sh' } })).status, 400);
});

test('config POST rejects prototype pollution, control characters and robots TTL over 24 h', async () => {
  const polluted = await request('POST', '/api/config', {
    headers: { 'Content-Type': 'application/json' },
    body: '{"politeness":{"__proto__":{"toString":"x"}}}',
  });
  assert.equal(polluted.status, 400);
  assert.equal(typeof Object.prototype.toString, 'function');
  assert.equal(String({}), '[object Object]');
  const inherited = await post('/api/config', { crawl: { hasOwnProperty: 1 } });
  assert.equal(inherited.status, 400);

  const crlf = await post('/api/config', { contact: 'ops@example.com\r\nX-Evil: 1' });
  assert.equal(crlf.status, 400);
  assert.equal(runtime.config.contact.includes('\n'), false);

  const longTtl = await post('/api/config', { robots: { cacheTtlMs: 30 * 24 * 3600 * 1000 } });
  assert.equal(longTtl.status, 400);

  // config.json on disk goes through deepMerge too.
  deepMerge({ politeness: {} }, JSON.parse('{"__proto__":{"polluted":1},"politeness":{"__proto__":{"polluted":2}}}'));
  assert.equal({}.polluted, undefined);
});

test('sign-preview headers verify via verify-signature', async () => {
  const preview = await post('/api/sign-preview', { url: 'https://example.com/page' });
  assert.equal(preview.status, 200);
  assert.ok(preview.json.headers['User-Agent'].includes('Cairn-User/1.0'));
  assert.ok(preview.json.signed);
  const verified = await post('/api/verify-signature', { url: 'https://example.com/page', headers: preview.json.headers });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.valid, true);
  assert.equal(verified.json.keyid, runtime.signer.keyId);
  const tampered = await post('/api/verify-signature', { url: 'https://other.example/page', headers: preview.json.headers });
  assert.equal(tampered.json.valid, false);
});

test('static /docs/ and /web/ are served safely', async (t) => {
  const css = await get('/docs/assets/docs.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.equal(css.headers['x-content-type-options'], 'nosniff');

  const traversal = await get('/docs/..%2fpackage.json');
  assert.equal(traversal.status, 404);
  const traversal2 = await get('/web/%2e%2e/%2e%2e/package.json');
  assert.equal(traversal2.status, 404);
  const dotted = await get('/docs/assets/..%2f..%2fSPEC.md');
  assert.equal(dotted.status, 404);

  const redirect = await get('/docs');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/docs/');

  if (fs.existsSync(path.join(ROOT, 'docs', 'index.html'))) {
    const docs = await get('/docs/');
    assert.equal(docs.status, 200);
    assert.match(docs.headers['content-type'], /text\/html/);
    assert.match(docs.headers['content-security-policy'], /default-src 'self'/);
  } else {
    t.diagnostic('docs/index.html not present; skipped /docs/ index check');
  }

  if (fs.existsSync(path.join(ROOT, 'web', 'index.html'))) {
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    const web = await get('/web/index.html');
    assert.equal(web.status, 200);
  } else {
    const home = await get('/');
    assert.equal(home.status, 200, 'fallback home page');
    t.diagnostic('web/index.html not present; checked fallback home page');
  }
});

test('CLI: help exits 0', () => {
  const r = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ['serve', 'crawl', 'search', 'ask', 'fetch', 'robots', 'keys', 'stats', 'audit', 'index', 'doctor', 'fixture', 'demo']) {
    assert.ok(r.stdout.includes(cmd), `help mentions ${cmd}`);
  }
  assert.ok(!r.stdout.includes('\x1b['), 'NO_COLOR respected');
  const bad = spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('CLI: doctor runs and reports checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-doctor-'));
  try {
    const env = { ...process.env, NO_COLOR: '1', CAIRN_CLAUDE_BIN: path.join(dir, 'no-claude'), CAIRN_PORT: '0' };
    const r = spawnSync(process.execPath, [CLI, 'doctor', '--data-dir', dir, '--json'], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const report = JSON.parse(r.stdout);
    const names = report.checks.map((c) => c.name);
    for (const n of ['Node.js', 'Data directory', 'Signing key', 'Claude CLI']) assert.ok(names.includes(n), n);
    assert.equal(report.checks.find((c) => c.name === 'Claude CLI').status, 'warn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: robots --file and search --json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cli-'));
  try {
    const robotsFile = path.join(dir, 'robots.txt');
    fs.writeFileSync(robotsFile, 'User-agent: CairnCorpus\nDisallow: /\n');
    const env = { ...process.env, NO_COLOR: '1' };
    const r = spawnSync(process.execPath, [CLI, 'robots', 'https://example.com/a', '--file', robotsFile, '--json', '--data-dir', dir], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.decisions.find((d) => d.role === 'corpus').allowed, false);
    assert.equal(res.decisions.find((d) => d.role === 'search').allowed, true);

    const s = spawnSync(process.execPath, [CLI, 'search', 'anything', '--json', '--data-dir', dir], { encoding: 'utf8', env, timeout: 30000 });
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).total, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
