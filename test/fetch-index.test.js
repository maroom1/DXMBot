// fetchAndExtract (POST /api/fetch, MCP fetch_page, `cairn fetch --index`):
// what may enter the search index from a user-triggered fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { fetchAndExtract, docForDisplay, acquireAskSlot, MAX_CONCURRENT_ASKS } from '../src/server/api.js';

let dataDir;
let runtime;
let server;
let base;
const state = { noidxMeta: '' };

const page = (title, body, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${body}</p></body></html>`;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-fetch-index-'));
  runtime = await createRuntime({ dataDir, politeness: { minDelayMs: 0 }, fetch: { retries: 0 } });
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    if (p === '/robots.txt') return send(200, 'text/plain', 'User-agent: CairnSearch\nDisallow: /nosearch/\n\nUser-agent: *\nDisallow: /private/\n');
    if (p === '/nosearch/page.html') return send(200, 'text/html', page('Search opt-out', 'Users may read this but it must not be indexed.'));
    if (p === '/private/page.html') return send(200, 'text/html', page('Private', 'Nobody should index this private page.'));
    if (p === '/scoped-header.html') return send(200, 'text/html', page('Scoped header', 'Header says CairnSearch noindex.'), { 'X-Robots-Tag': 'CairnSearch: noindex' });
    if (p === '/scoped-meta.html') return send(200, 'text/html', page('Scoped meta', 'Meta says CairnSearch noindex.', '<meta name="CairnSearch" content="noindex">'));
    if (p === '/later-noindex.html') return send(200, 'text/html', page('Later noindex', 'This page opts out later.', state.noidxMeta));
    if (p === '/about.html') return send(200, 'text/html', page('About', 'We make durable trail equipment in Boise.'));
    if (p === '/canonical-dup.html') return send(200, 'text/html', page('About copy', 'A copy of the about page with other words.', '<link rel="canonical" href="/about.html">'));
    if (p === '/same-text.html') return send(200, 'text/html', page('About', 'We make durable trail equipment in Boise.'));
    if (p === '/go-private') return send(302, 'text/plain', '', { Location: '/private/page.html' });
    return send(404, 'text/plain', 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await runtime.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const fetchIndex = (p, opts = {}) => fetchAndExtract(runtime, { url: `${base}${p}`, role: 'user', index: true, ...opts });

test('a user fetch never indexes a page CairnSearch is disallowed from', async () => {
  const r = await fetchIndex('/nosearch/page.html');
  assert.equal(r.result.status, 200, 'the user role itself may fetch it');
  assert.equal(r.indexed, 'blocked-robots');
  assert.equal(runtime.index.has(`${base}/nosearch/page.html`), false);
});

test('with respectForUserFetch off, a robots-disallowed page is fetched but not indexed', async () => {
  runtime.config.robots.respectForUserFetch = false;
  try {
    const r = await fetchIndex('/private/page.html');
    assert.equal(r.result.status, 200);
    assert.equal(r.robots.allowed, false);
    assert.equal(r.indexed, 'blocked-robots');
    assert.equal(runtime.index.has(`${base}/private/page.html`), false);
  } finally {
    runtime.config.robots.respectForUserFetch = true;
  }
});

test('CairnSearch-scoped noindex (header or meta) applies to the user-fetch index path', async () => {
  assert.equal((await fetchIndex('/scoped-header.html')).indexed, 'noindex');
  assert.equal((await fetchIndex('/scoped-meta.html')).indexed, 'noindex');
  assert.equal(runtime.index.has(`${base}/scoped-meta.html`), false);
});

test('a page that becomes noindex is removed from the index', async () => {
  state.noidxMeta = '';
  assert.equal((await fetchIndex('/later-noindex.html')).indexed, 'added');
  assert.equal(runtime.index.has(`${base}/later-noindex.html`), true);
  state.noidxMeta = '<meta name="robots" content="noindex">';
  assert.equal((await fetchIndex('/later-noindex.html')).indexed, 'noindex');
  assert.equal(runtime.index.has(`${base}/later-noindex.html`), false);
});

test('canonical and identical-content duplicates are not indexed (same rules as the crawler)', async () => {
  assert.equal((await fetchIndex('/about.html')).indexed, 'added');
  assert.equal((await fetchIndex('/canonical-dup.html')).indexed, 'duplicate');
  assert.equal((await fetchIndex('/same-text.html')).indexed, 'duplicate');
  assert.equal((await fetchIndex('/about.html')).indexed, 'unchanged');
});

test('robots in the response describes the redirect hop that was blocked', async () => {
  const r = await fetchAndExtract(runtime, { url: `${base}/go-private`, role: 'user' });
  assert.equal(r.result.blocked?.reason, 'robots');
  assert.equal(r.robots.allowed, false);
  assert.equal(r.robots.url, `${base}/private/page.html`);
  assert.deepEqual(r.robots.rule, { type: 'disallow', path: '/private/' });
});

test('noarchive/nosnippet docs are shown without their stored text', () => {
  const doc = { url: 'https://ex.com/', title: 'T', description: 'D', text: 'body', markdown: '# body', headings: [{ level: 1, text: 'body' }] };
  assert.equal(docForDisplay(doc), doc);
  const na = docForDisplay({ ...doc, noarchive: true });
  assert.equal(na.text, '');
  assert.equal(na.markdown, '');
  assert.equal(na.contentWithheld, 'noarchive');
  const ns = docForDisplay({ ...doc, nosnippet: true });
  assert.equal(ns.description, '');
  assert.deepEqual(ns.headings, []);
  assert.equal(ns.contentWithheld, 'nosnippet');
});

test('concurrent answers are capped (429 beyond the limit)', () => {
  const rt = {};
  const releases = Array.from({ length: MAX_CONCURRENT_ASKS }, () => acquireAskSlot(rt));
  assert.throws(() => acquireAskSlot(rt), (err) => err.status === 429);
  releases[0]();
  releases[0](); // double release is harmless
  const again = acquireAskSlot(rt);
  assert.throws(() => acquireAskSlot(rt), (err) => err.status === 429);
  again();
  releases.slice(1).forEach((r) => r());
});
