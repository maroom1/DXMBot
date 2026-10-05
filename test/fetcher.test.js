import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { AuditLog } from '../src/util/audit.js';
import { Signer, verifyRequest } from '../src/net/signing.js';
import { HostScheduler } from '../src/net/ratelimit.js';
import { Fetcher, parseXRobotsTag } from '../src/net/fetcher.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-fetcher-'));
const servers = [];

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Throwaway HTTP server. `routes` maps a path (or path+query) to a handler;
// every request is recorded so tests can prove what was (not) fetched.
async function startSite(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    const handler = routes[req.url] || routes[req.url.split('?')[0]];
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const site = {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    paths: () => requests.map((r) => r.path),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(site);
  return site;
}

const text = (body, headers = {}) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
};
const html = (body, headers = {}) => text(body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
const robots = (body) => text(body);
const redirect = (location, status = 302) => (req, res) => {
  res.writeHead(status, { Location: location });
  res.end();
};

let setupCount = 0;
async function setup(overrides = {}) {
  const dataDir = path.join(tmpRoot, `data-${++setupCount}`);
  const config = loadConfig({
    dataDir,
    politeness: { minDelayMs: 0, backoffBaseMs: 10, maxBackoffMs: 50, maxConcurrencyPerHost: 1, globalConcurrency: 8 },
    fetch: { timeoutMs: 1500, retries: 2, maxBytes: 5242880, maxRedirects: 5 },
    ...overrides,
  });
  const audit = new AuditLog({});
  const signer = await new Signer({ keyDir: path.join(tmpRoot, 'keys'), config }).init();
  const scheduler = new HostScheduler(config.politeness);
  const fetcher = new Fetcher({ config, scheduler, signer, audit });
  const fetchEntries = () => audit.recent({ limit: 1000, kind: 'fetch' }).reverse();
  return { config, audit, signer, scheduler, fetcher, fetchEntries };
}

const ALLOW_ALL = 'User-agent: *\nDisallow:\n';

test('sends honest identity and Web Bot Auth headers', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/echo': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    },
  });
  const { config, signer, fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/echo`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 200);
  assert.equal(r.signed, true);
  assert.equal(r.role, 'search');
  assert.equal(r.contentType, 'application/json');

  const sent = site.requests.find((x) => x.path === '/echo').headers;
  assert.match(sent['user-agent'], /CairnSearch\/1\.0/);
  assert.ok(sent['user-agent'].includes(`+${config.publicBaseUrl}/bot`));
  assert.equal(r.userAgent, sent['user-agent']);
  assert.equal(sent.from, config.contact);
  assert.equal(sent['accept-language'], 'en');
  assert.match(sent.accept, /^text\/html/);
  assert.equal(sent['signature-agent'], `"${config.publicBaseUrl}"`);
  assert.match(sent['signature-input'], /^sig1=\("@authority" "signature-agent"\);.*tag="web-bot-auth"$/);
  assert.match(sent.signature, /^sig1=:.+:$/);
  const v = verifyRequest({ method: 'GET', url: `${site.url}/echo`, headers: sent }, signer.jwks());
  assert.equal(v.valid, true, v.reason);

  // The robots.txt fetch is identified and signed too.
  const robotsReq = site.requests.find((x) => x.path === '/robots.txt').headers;
  assert.match(robotsReq['user-agent'], /CairnSearch\/1\.0/);
  assert.ok(robotsReq.signature);
  assert.deepEqual(JSON.parse(r.body)['user-agent'], sent['user-agent']);
});

test('signing disabled sends no signature headers', async () => {
  const site = await startSite({ '/robots.txt': robots(ALLOW_ALL), '/p': text('ok') });
  const { fetcher } = await setup({ signing: { enabled: false } });
  const r = await fetcher.fetch(`${site.url}/p`);
  assert.equal(r.ok, true);
  assert.equal(r.signed, false);
  const sent = site.requests.find((x) => x.path === '/p').headers;
  assert.equal(sent.signature, undefined);
  assert.equal(sent['signature-input'], undefined);
});

test('robots disallow blocks without contacting the page', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: CairnSearch\nDisallow: /private/\n'),
    '/private/secret.html': html('<p>secret</p>'),
  });
  const { fetcher, fetchEntries } = await setup();
  const r = await fetcher.fetch(`${site.url}/private/secret.html`);
  assert.equal(r.ok, false);
  assert.equal(r.blocked.reason, 'robots');
  assert.deepEqual(r.blocked.rule, { type: 'disallow', path: '/private/' });
  assert.equal(r.status, null);
  assert.equal(r.body, null);
  assert.deepEqual(site.paths(), ['/robots.txt']);

  const blocked = fetchEntries().filter((e) => e.blocked === 'robots');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, null);
  assert.equal(blocked[0].robots, 'disallowed');
  assert.equal(blocked[0].token, 'CairnSearch');
});

test('robots groups are per role: corpus blocked, search allowed', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: CairnCorpus\nDisallow: /\n'),
    '/page': html('<p>hi</p>'),
  });
  const { fetcher } = await setup();
  assert.equal((await fetcher.fetch(`${site.url}/page`, { role: 'corpus' })).blocked?.reason, 'robots');
  assert.equal((await fetcher.fetch(`${site.url}/page`, { role: 'search' })).ok, true);
  const check = await fetcher.checkRobots(`${site.url}/page`, 'corpus');
  assert.equal(check.allowed, false);
});

test('redirect to a disallowed path is blocked and the target is never requested', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: *\nDisallow: /private/\n'),
    '/go': redirect('/private/secret.html'),
    '/private/secret.html': html('secret'),
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/go`);
  assert.equal(r.blocked?.reason, 'robots');
  assert.equal(r.finalUrl, `${site.url}/private/secret.html`);
  assert.deepEqual(r.redirects, [{ from: `${site.url}/go`, to: `${site.url}/private/secret.html`, status: 302 }]);
  assert.ok(!site.paths().includes('/private/secret.html'));
});

test('same-origin redirect is followed', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/old': redirect('/new', 301),
    '/new': html('<title>New</title>'),
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/old`);
  assert.equal(r.ok, true);
  assert.equal(r.url, `${site.url}/old`);
  assert.equal(r.finalUrl, `${site.url}/new`);
  assert.equal(r.redirects.length, 1);
  assert.equal(r.body, '<title>New</title>');
});

test('cross-origin redirect fetches the second origin robots.txt', async () => {
  const b = await startSite({
    '/robots.txt': robots('User-agent: *\nDisallow: /nope\n'),
    '/landing': html('<p>landed</p>'),
  });
  const a = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/hop': redirect(`${b.url}/landing`, 301),
    '/hop-blocked': redirect(`${b.url}/nope`, 302),
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${a.url}/hop`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.finalUrl, `${b.url}/landing`);
  assert.deepEqual(r.redirects, [{ from: `${a.url}/hop`, to: `${b.url}/landing`, status: 301 }]);
  assert.deepEqual(b.paths(), ['/robots.txt', '/landing']);

  const blocked = await fetcher.fetch(`${a.url}/hop-blocked`);
  assert.equal(blocked.blocked?.reason, 'robots');
  assert.ok(!b.paths().includes('/nope'));
});

test('redirect loop stops at maxRedirects', async () => {
  let n = 0;
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/loop': (req, res) => redirect(`/loop?n=${++n}`)(req, res),
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/loop`);
  assert.equal(r.ok, false);
  assert.match(r.error, /Too many redirects/);
  assert.equal(r.redirects.length, 5);
});

test('redirect to a non-http scheme is blocked', async () => {
  const site = await startSite({ '/robots.txt': robots(ALLOW_ALL), '/ftp': redirect('ftp://example.com/file') });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/ftp`);
  assert.equal(r.blocked?.reason, 'scheme');
});

test('429 with Retry-After is retried after the requested wait, then succeeds', async () => {
  let hits = 0;
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/rate': (req, res) => {
      if (++hits === 1) {
        res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' });
        return res.end('slow down');
      }
      return text('finally')(req, res);
    },
  });
  const { fetcher, fetchEntries } = await setup();
  const t0 = Date.now();
  const r = await fetcher.fetch(`${site.url}/rate`);
  const took = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'finally');
  assert.ok(took >= 950, `Retry-After honoured (waited ${took} ms)`);

  const attempts = fetchEntries().filter((e) => e.url === `${site.url}/rate`);
  assert.deepEqual(attempts.map((e) => [e.status, e.attempt]), [[429, 1], [200, 2]]);
  assert.ok(attempts.every((e) => e.signed === true && e.robots === 'allowed' && e.role === 'search'));
});

test('503 is retried with backoff; exhausting retries returns the error status', async () => {
  let flaky = 0;
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/flaky': (req, res) => {
      if (++flaky === 1) {
        res.writeHead(503);
        return res.end();
      }
      return text('recovered')(req, res);
    },
    '/down': (req, res) => {
      res.writeHead(500);
      res.end('broken');
    },
  });
  const { fetcher, fetchEntries, scheduler } = await setup();
  const r = await fetcher.fetch(`${site.url}/flaky`);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'recovered');
  const host = new URL(site.url).host;
  assert.equal(scheduler.stats().find((s) => s.host === host).backoffMs, 0, 'success resets backoff');

  const down = await fetcher.fetch(`${site.url}/down`);
  assert.equal(down.ok, false);
  assert.equal(down.status, 500);
  assert.equal(site.paths().filter((p) => p === '/down').length, 3, '1 try + 2 retries');
  assert.deepEqual(
    fetchEntries().filter((e) => e.url === `${site.url}/down`).map((e) => e.attempt),
    [1, 2, 3],
  );
});

test('network errors are retried and reported', async () => {
  const site = await startSite({});
  const deadUrl = `${site.url}/x`;
  await site.close();
  const { fetcher, fetchEntries } = await setup();
  const r = await fetcher.fetch(deadUrl, { role: 'user', respectRobots: false });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.ok(r.error);
  const attempts = fetchEntries().filter((e) => e.url === deadUrl);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((e) => e.error && e.robots === 'skipped'));
});

test('unreachable robots.txt means disallow-all', async () => {
  const site = await startSite({});
  const deadUrl = `${site.url}/page`;
  await site.close();
  const { fetcher } = await setup();
  const r = await fetcher.fetch(deadUrl);
  assert.equal(r.blocked?.reason, 'robots');
});

test('maxBytes truncates a never-ending body without buffering it all', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/big': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(16 * 1024, 'a');
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => clearInterval(timer));
    },
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/big`, { maxBytes: 50_000 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.bytes, 50_000);
  assert.equal(r.body.length, 50_000);

  const small = await fetcher.fetch(`${site.url}/robots.txt`);
  assert.equal(small.truncated, false);
});

test('timeout aborts the request with an error', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/slow': (req, res) => {
      const t = setTimeout(() => text('late')(req, res), 5000);
      res.on('close', () => clearTimeout(t));
    },
  });
  const { fetcher, fetchEntries } = await setup();
  const t0 = Date.now();
  const r = await fetcher.fetch(`${site.url}/slow`);
  const took = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.error, /Timed out after 1500 ms/);
  assert.ok(took >= 1400 && took < 3000, `took ${took} ms`);
  assert.equal(fetchEntries().filter((e) => e.url === `${site.url}/slow`).length, 1, 'timeouts are not retried');
});

test('non-http schemes and invalid URLs are blocked before any I/O', async () => {
  const { fetcher, fetchEntries } = await setup();
  assert.equal((await fetcher.fetch('ftp://example.com/file')).blocked.reason, 'scheme');
  assert.equal((await fetcher.fetch('file:///etc/passwd')).blocked.reason, 'scheme');
  assert.equal((await fetcher.fetch('javascript:alert(1)')).blocked.reason, 'scheme');
  assert.equal((await fetcher.fetch('not a url')).blocked.reason, 'invalid-url');
  assert.ok(fetchEntries().every((e) => e.blocked && e.status === null));
});

test('private network block (when enabled)', async () => {
  const site = await startSite({ '/robots.txt': robots(ALLOW_ALL), '/p': text('x') });
  const { fetcher } = await setup({ fetch: { blockPrivateNetworks: true } });
  const r = await fetcher.fetch(`${site.url}/p`);
  assert.equal(r.blocked?.reason, 'private-network');
  assert.equal(site.requests.length, 0);
});

test('X-Robots-Tag is parsed, including bot-scoped directives', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/scoped': html('x', { 'X-Robots-Tag': 'CairnSearch: noindex' }),
    '/global': html('x', { 'X-Robots-Tag': 'noarchive, nosnippet' }),
  });
  const { fetcher } = await setup();
  const scoped = await fetcher.fetch(`${site.url}/scoped`);
  assert.deepEqual(scoped.xRobotsTag, { noindex: true, nofollow: false, noarchive: false, nosnippet: false });
  const asUser = await fetcher.fetch(`${site.url}/scoped`, { role: 'user' });
  assert.equal(asUser.xRobotsTag.noindex, false, 'scoped to CairnSearch only');
  const global = await fetcher.fetch(`${site.url}/global`);
  assert.deepEqual(global.xRobotsTag, { noindex: false, nofollow: false, noarchive: true, nosnippet: true });
});

test('parseXRobotsTag handles scopes, none, and value directives', () => {
  const t = ['CairnSearch', 'Cairn'];
  assert.deepEqual(parseXRobotsTag('none', t), { noindex: true, nofollow: true, noarchive: false, nosnippet: false });
  assert.equal(parseXRobotsTag('otherbot: noindex, nofollow', t).noindex, false);
  // Repeated header lines arrive joined with ", ": a bare directive after a
  // foreign scope may be its own unscoped line, so it applies (fail closed).
  assert.equal(parseXRobotsTag('otherbot: noindex, nofollow', t).nofollow, true);
  assert.equal(parseXRobotsTag('cairnsearch: NOINDEX', t).noindex, true);
  assert.equal(parseXRobotsTag('Cairn: nofollow', t).nofollow, true, 'family token applies');
  assert.equal(parseXRobotsTag('max-snippet: 20, noindex', t).noindex, true);
  assert.equal(parseXRobotsTag('otherbot: noindex, CairnSearch: nosnippet', t).nosnippet, true);
  assert.equal(parseXRobotsTag('otherbot: noindex, CairnSearch: nosnippet', t).noindex, false);
  assert.deepEqual(parseXRobotsTag(undefined, t), { noindex: false, nofollow: false, noarchive: false, nosnippet: false });
});

test('user role respects robots by default and skips it when respectForUserFetch=false', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: *\nDisallow: /\n'),
    '/page': html('<p>asked for</p>'),
  });
  const strict = await setup();
  const blocked = await strict.fetcher.fetch(`${site.url}/page`, { role: 'user' });
  assert.equal(blocked.blocked?.reason, 'robots');

  const before = site.requests.length;
  const lax = await setup({ robots: { respectForUserFetch: false } });
  const r = await lax.fetcher.fetch(`${site.url}/page`, { role: 'user' });
  assert.equal(r.ok, true);
  assert.equal(r.body, '<p>asked for</p>');
  assert.deepEqual(site.paths().slice(before), ['/page'], 'robots.txt not consulted');
  const sent = site.requests.at(-1).headers;
  assert.match(sent['user-agent'], /Cairn-User\/1\.0/);
  const [entry] = lax.fetchEntries();
  assert.equal(entry.robots, 'skipped');
  assert.equal(entry.token, 'Cairn-User');

  // search role is never exempt
  assert.equal((await lax.fetcher.fetch(`${site.url}/page`)).blocked?.reason, 'robots');
});

test('respects charset from Content-Type', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/latin1': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=ISO-8859-1' });
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café"
    },
  });
  const { fetcher } = await setup();
  assert.equal((await fetcher.fetch(`${site.url}/latin1`)).body, 'café');
});

test('fetchRaw bypasses robots but is still identified and audited', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: *\nDisallow: /\n'),
    '/raw': text('raw body'),
  });
  const { fetcher, audit } = await setup();
  const r = await fetcher.fetchRaw(`${site.url}/raw`, { role: 'search', kind: 'robots' });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'raw body');
  assert.equal(r.error, null);
  assert.deepEqual(site.paths(), ['/raw']);
  assert.match(site.requests[0].headers['user-agent'], /CairnSearch/);
  const [e] = audit.recent({ kind: 'robots' });
  assert.equal(e.url, `${site.url}/raw`);
  assert.equal(e.status, 200);
});

test('robots.txt fetch audit entries use kind "robots"', async () => {
  const site = await startSite({ '/robots.txt': robots(ALLOW_ALL), '/p': text('p') });
  const { fetcher, audit } = await setup();
  await fetcher.fetch(`${site.url}/p`);
  const robotsEntries = audit.recent({ kind: 'robots' });
  assert.equal(robotsEntries.length, 1);
  assert.equal(robotsEntries[0].url, `${site.url}/robots.txt`);
  assert.equal(robotsEntries[0].robots, 'skipped');
  const fetchEntry = audit.recent({ kind: 'fetch' })[0];
  for (const k of ['role', 'token', 'method', 'url', 'finalUrl', 'status', 'bytes', 'elapsedMs', 'robots', 'rule', 'blocked', 'signed', 'attempt', 'error']) {
    assert.ok(k in fetchEntry, `audit entry has ${k}`);
  }
  assert.equal(fetchEntry.bytes, 1);
});

test('fetchImpl can be injected', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    return new Response('<h1>fake</h1>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const { config, audit, signer, scheduler } = await setup();
  const fetcher = new Fetcher({ config, scheduler, signer, audit, fetchImpl: fakeFetch });
  const r = await fetcher.fetch('https://fake.example/page');
  assert.equal(r.ok, true);
  assert.equal(r.body, '<h1>fake</h1>');
  assert.deepEqual(calls.map((c) => c.url), ['https://fake.example/robots.txt', 'https://fake.example/page']);
  assert.equal(calls[1].init.redirect, 'manual');
  assert.match(calls[1].init.headers['User-Agent'], /CairnSearch\/1\.0/);
});

test('caller abort signal cancels the fetch', async () => {
  const site = await startSite({
    '/robots.txt': robots(ALLOW_ALL),
    '/hang': (req, res) => {
      const t = setTimeout(() => text('late')(req, res), 5000);
      res.on('close', () => clearTimeout(t));
    },
  });
  const { fetcher } = await setup();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const r = await fetcher.fetch(`${site.url}/hang`, { signal: ac.signal });
  assert.equal(r.ok, false);
  assert.match(r.error, /Abort/i);
  assert.ok(Date.now() - t0 < 1000);
});

test('X-Robots-Tag: joined header lines fail closed; max-snippet:0 and nocache are honoured', () => {
  const t = ['CairnSearch', 'Cairn'];
  // "X-Robots-Tag: otherbot: noindex" + "X-Robots-Tag: nofollow" as delivered by fetch()
  const joined = parseXRobotsTag('otherbot: noindex, nofollow', t);
  assert.equal(joined.noindex, false, 'directive attached to a foreign prefix is skipped');
  assert.equal(joined.nofollow, true, 'the site-wide nofollow line is not lost');
  assert.equal(parseXRobotsTag('max-snippet: 0', t).nosnippet, true);
  assert.equal(parseXRobotsTag('CairnSearch: max-snippet:0', t).nosnippet, true);
  assert.equal(parseXRobotsTag('max-snippet: 20', t).nosnippet, false);
  assert.equal(parseXRobotsTag('nocache', t).noarchive, true);
});

test('search and corpus roles cannot opt out of robots.txt', async () => {
  const site = await startSite({ '/robots.txt': robots('User-agent: *\nDisallow: /\n'), '/p': text('x') });
  const { fetcher } = await setup();
  for (const role of ['search', 'corpus']) {
    const r = await fetcher.fetch(`${site.url}/p`, { role, respectRobots: false });
    assert.equal(r.blocked?.reason, 'robots', role);
  }
  const user = await fetcher.fetch(`${site.url}/p`, { role: 'user', respectRobots: false });
  assert.equal(user.status, 200, 'the user role may still be overridden explicitly');
  assert.equal(site.paths().filter((p) => p === '/p').length, 1);
});

test('private network block also covers robots.txt fetches (checkRobots / fetchRaw)', async () => {
  const site = await startSite({ '/robots.txt': robots(ALLOW_ALL), '/p': text('x') });
  const { fetcher } = await setup({ fetch: { blockPrivateNetworks: true } });
  const check = await fetcher.checkRobots(`${site.url}/p`, 'search');
  assert.equal(check.allowed, false, 'never read, so treated as unreachable (disallow all)');
  const raw = await fetcher.fetchRaw(`${site.url}/robots.txt`);
  assert.equal(raw.status, 0);
  assert.match(raw.error, /private or loopback/);
  assert.equal(site.requests.length, 0, 'nothing was sent to the loopback host');
});

test('private network block checks DNS answers, not just literal hostnames', async () => {
  const calls = [];
  const config = loadConfig({ dataDir: path.join(tmpRoot, 'dns'), politeness: { minDelayMs: 0 }, fetch: { blockPrivateNetworks: true, retries: 0 } });
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response('User-agent: *\nDisallow:\n', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const lookup = async (host) => (host === 'intranet.example' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const fetcher = new Fetcher({ config, scheduler: new HostScheduler(config.politeness), fetchImpl, lookup });
  const r = await fetcher.fetch('http://intranet.example/x', { role: 'user' });
  assert.equal(r.blocked?.reason, 'private-network');
  assert.match(r.blocked.detail, /10\.1\.2\.3/);
  const mapped = await fetcher.fetch('http://[::ffff:127.0.0.1]/x', { role: 'user' });
  assert.equal(mapped.blocked?.reason, 'private-network', 'IPv4-mapped IPv6 loopback');
  assert.equal(calls.length, 0);
  const ok = await fetcher.fetch('http://public.example/x', { role: 'user' });
  assert.equal(ok.status, 200);
});

test('a robots.txt redirect Cairn refuses to follow is unreachable (disallow all), not allow-all', async () => {
  const site = await startSite({ '/robots.txt': redirect('file:///etc/passwd'), '/p': text('x') });
  const { fetcher } = await setup();
  const check = await fetcher.checkRobots(`${site.url}/p`, 'search');
  assert.equal(check.allowed, false);
  assert.equal(check.status, 0);
  const r = await fetcher.fetch(`${site.url}/p`);
  assert.equal(r.blocked?.reason, 'robots');
  assert.equal(site.paths().includes('/p'), false);
});

test('an extreme Crawl-delay is treated as disallowed instead of queueing for days', async () => {
  const site = await startSite({ '/robots.txt': robots('User-agent: *\nCrawl-delay: 3000000\n'), '/p': text('x') });
  const { fetcher } = await setup();
  const started = Date.now();
  const r = await fetcher.fetch(`${site.url}/p`);
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.blocked?.reason, 'robots');
  assert.match(r.blocked.detail, /Crawl-delay/);
  assert.equal(r.blocked.robots.crawlDelayLimit, 300);
  assert.equal(site.paths().includes('/p'), false);
});

test('a robots block on a redirect hop carries that hop\'s decision', async () => {
  const site = await startSite({
    '/robots.txt': robots('User-agent: *\nDisallow: /private/\n'),
    '/go': redirect('/private/x'),
  });
  const { fetcher } = await setup();
  const r = await fetcher.fetch(`${site.url}/go`, { role: 'user' });
  assert.equal(r.blocked?.reason, 'robots');
  assert.equal(r.blocked.robots.url, `${site.url}/private/x`);
  assert.equal(r.blocked.robots.allowed, false);
  assert.deepEqual(r.blocked.robots.rule, { type: 'disallow', path: '/private/' });
  assert.equal(r.blocked.robots.matchedAgent, '*');
});
