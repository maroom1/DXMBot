// End-to-end: a real Cairn runtime crawls the "Northwind Trails" fixture site
// over HTTP and we assert, from the site's own request log, that Cairn behaved
// like a well-mannered, honest crawler.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime } from '../src/runtime.js';
import { startServer } from '../src/server/app.js';
import { answerQuestion } from '../src/agent/answer.js';
import { startFixtureSite } from '../fixtures/site-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.js');

const pathsOf = (requests) => requests.map((r) => r.path);
const requested = (requests, p) => requests.some((r) => r.path === p);
const countOf = (requests, p) => requests.filter((r) => r.path === p).length;

async function closeQuietly(fn) {
  try {
    await Promise.race([fn(), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  } catch {
    // Cleanup must never mask the real test result.
  }
}

async function runCrawl(runtime, opts) {
  const job = runtime.jobs.create(opts);
  const id = job.id ?? job.status().id;
  const pages = [];
  // run() is async and awaits robots first, so no 'page' event fires before this listener is attached.
  job.on('page', (p) => pages.push(p));
  const status = await runtime.jobs.waitFor(id, 90_000);
  return { id, status, pages };
}

describe('end-to-end: crawl, index, fetch, answer against the Northwind Trails fixture', { timeout: 180_000 }, () => {
  let tmp;
  let runtime;
  let site;
  let corpusSite;
  let server;
  let crawl;
  let crawlRequests;
  let u; // absolute URL on the fixture for a path

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-e2e-'));
    delete process.env.FAKE_CLAUDE_MODE;
    process.env.CAIRN_CLAUDE_BIN = FAKE_CLAUDE;
    site = await startFixtureSite();
    u = (p) => site.url + p;
    runtime = await createRuntime({
      dataDir: tmp,
      politeness: { minDelayMs: 0, backoffBaseMs: 10, maxBackoffMs: 100 },
      fetch: { timeoutMs: 5000 },
      agent: { claudeBin: FAKE_CLAUDE },
    });
    crawl = await runCrawl(runtime, { seeds: [u('/')], role: 'search', maxPages: 60, maxDepth: 6 });
    crawlRequests = [...site.requests];
  });

  after(async () => {
    if (server) await closeQuietly(async () => {
      const closing = server.close();
      server.server?.closeAllConnections?.();
      await closing;
    });
    if (runtime) await closeQuietly(() => runtime.close());
    if (site) await closeQuietly(() => site.close());
    if (corpusSite) await closeQuietly(() => corpusSite.close());
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('search-role crawl', () => {
    it('finishes cleanly', () => {
      assert.equal(crawl.status.state, 'done', `job state: ${JSON.stringify(crawl.status.error)}`);
      assert.ok(crawl.status.counts.indexed >= 10, `indexed only ${crawl.status.counts.indexed} pages`);
    });

    it('fetches robots.txt once and identifies itself honestly on every request', () => {
      assert.equal(countOf(crawlRequests, '/robots.txt'), 1, 'robots.txt should be fetched once and cached');
      assert.equal(crawlRequests[0].path, '/robots.txt', 'robots.txt must be the first request');
      for (const r of crawlRequests) {
        const ua = r.headers['user-agent'] || '';
        assert.match(ua, /CairnSearch\/1\.0/, `UA for ${r.path}: ${ua}`);
        assert.match(ua, /\+\S+\/bot\b/, `UA for ${r.path} must link the /bot info page: ${ua}`);
        assert.doesNotMatch(ua, /Chrome\/|Safari\/|Firefox\//, 'must never impersonate a browser');
      }
      const pageRequest = crawlRequests.find((r) => r.path === '/about.html');
      assert.ok(pageRequest, '/about.html requested');
      assert.ok(pageRequest.headers.from, 'From header carries the operator contact');
      assert.match(pageRequest.headers['signature-input'] || '', /tag="web-bot-auth"/, 'requests are signed (Web Bot Auth)');
      assert.ok(pageRequest.headers['signature-agent'], 'Signature-Agent header present');
    });

    it('never requests robots-disallowed URLs', () => {
      const paths = pathsOf(crawlRequests);
      for (const p of paths) {
        assert.ok(!p.startsWith('/private/') || p === '/private/public-note.html', `requested disallowed ${p}`);
        assert.ok(!p.startsWith('/admin/'), `requested ${p}`);
        assert.ok(!p.startsWith('/search?'), `requested disallowed ${p}`);
      }
      assert.ok(!requested(crawlRequests, '/private/secret.html'), 'secret page was requested');
      assert.ok(!requested(crawlRequests, '/file.pdf'), 'PDF (Disallow: /*.pdf$) was requested');
    });

    it('indexes the explicitly allowed /private/public-note.html', () => {
      assert.ok(requested(crawlRequests, '/private/public-note.html'));
      assert.ok(runtime.index.has(u('/private/public-note.html')), 'public note should be indexed');
    });

    it('blocks a redirect into a disallowed path', () => {
      assert.ok(requested(crawlRequests, '/redirect-to-private'), 'the redirecting URL itself is allowed');
      assert.ok(!requested(crawlRequests, '/private/secret.html'), 'redirect target must not be requested');
      const ev = crawl.pages.find((p) => p.url === u('/redirect-to-private'));
      if (ev) assert.equal(ev.outcome, 'blocked-robots');
      const blocked = runtime.audit.recent({ limit: 2000, kind: 'fetch' }).filter((e) => e.blocked === 'robots');
      assert.ok(blocked.some((e) => /\/private\/secret\.html/.test(`${e.url} ${e.finalUrl ?? ''}`) || e.url === u('/redirect-to-private')), 'audit records the robots block');
      for (const doc of runtime.index.list({ limit: 1000 }).docs) {
        assert.ok(!doc.url.includes('/private/secret.html'), 'secret page must not be indexed');
      }
    });

    it('respects meta robots noindex and X-Robots-Tag noindex but still follows their links', () => {
      assert.ok(requested(crawlRequests, '/noindex.html'));
      assert.ok(requested(crawlRequests, '/xrobots.html'));
      assert.ok(!runtime.index.has(u('/noindex.html')), 'meta noindex page indexed');
      assert.ok(!runtime.index.has(u('/xrobots.html')), 'X-Robots-Tag noindex page indexed');
      for (const p of ['/noindex.html', '/xrobots.html']) {
        const ev = crawl.pages.find((e) => e.url === u(p));
        if (ev) assert.equal(ev.outcome, 'noindex', `${p} outcome`);
      }
      assert.ok(requested(crawlRequests, '/via-noindex.html'), 'links on a noindex (but followable) page are followed');
      assert.ok(runtime.index.has(u('/via-noindex.html')));
    });

    it('does not discover pages through nofollow links', () => {
      assert.ok(requested(crawlRequests, '/nofollow.html'));
      assert.ok(requested(crawlRequests, '/rel-nofollow.html'));
      assert.ok(runtime.index.has(u('/nofollow.html')), 'a nofollow (but indexable) page is itself indexed');
      assert.ok(!requested(crawlRequests, '/hidden-behind-nofollow.html'), 'meta nofollow link was followed');
      assert.ok(!requested(crawlRequests, '/hidden-rel-nofollow.html'), 'rel=nofollow link was followed');
      assert.ok(!runtime.index.has(u('/hidden-behind-nofollow.html')));
      assert.ok(!runtime.index.has(u('/hidden-rel-nofollow.html')));
    });

    it('discovers the orphan page through the sitemap index', () => {
      assert.ok(requested(crawlRequests, '/sitemap.xml'));
      assert.ok(requested(crawlRequests, '/sitemap-pages.xml'), 'sitemap index was not followed');
      assert.ok(requested(crawlRequests, '/orphan.html'));
      assert.ok(runtime.index.has(u('/orphan.html')), 'orphan page should be indexed');
    });

    it('follows the depth chain to maxDepth', () => {
      assert.ok(runtime.index.has(u('/blog/deep/level-3.html')));
      assert.ok(runtime.index.has(u('/blog/deep/level-4.html')));
    });

    it('retries 429 (Retry-After) and 503 responses until the page is fetched', () => {
      assert.ok(countOf(crawlRequests, '/rate-limited') >= 2, '429 was not retried');
      assert.ok(runtime.index.has(u('/rate-limited')), 'rate-limited page eventually indexed');
      assert.ok(countOf(crawlRequests, '/flaky') >= 2, '503 was not retried');
      assert.ok(runtime.index.has(u('/flaky')), 'flaky page eventually indexed');
      const [first, second] = crawlRequests.filter((r) => r.path === '/rate-limited');
      assert.ok(second.ts - first.ts >= 900, `Retry-After: 1 not honoured (retried after ${second.ts - first.ts} ms)`);
    });

    it('deduplicates canonical and identical-content pages', () => {
      assert.ok(runtime.index.has(u('/about.html')));
      assert.ok(!runtime.index.has(u('/canonical-dup.html')), 'canonical duplicate indexed under its own URL');
      const dupPair = [u('/blog/post-1.html'), u('/dup-content.html')].filter((x) => runtime.index.has(x));
      assert.equal(dupPair.length, 1, `exactly one of the identical pages should be indexed, got ${dupPair.join(', ')}`);
    });

    it('ranks the Ridgeback product page first for "ridgeback weight"', () => {
      const res = runtime.index.search('ridgeback weight');
      assert.ok(res.total >= 1);
      assert.equal(res.results[0].url, u('/products/ridgeback-45.html'));
      assert.match(res.results[0].title, /Ridgeback 45/);
    });
  });

  describe('corpus-role crawl', () => {
    it('stops at robots.txt when CairnCorpus is disallowed and writes nothing', async () => {
      corpusSite = await startFixtureSite();
      const docsBefore = runtime.index.stats().docs;
      const res = await runCrawl(runtime, { seeds: [corpusSite.url + '/'], role: 'corpus', maxPages: 60, maxDepth: 6 });
      assert.equal(res.status.state, 'done');

      const paths = pathsOf(corpusSite.requests);
      assert.ok(paths.length >= 1, 'robots.txt should have been fetched');
      assert.deepEqual([...new Set(paths)], ['/robots.txt'], `corpus crawl requested ${paths.join(', ')}`);
      for (const r of corpusSite.requests) assert.match(r.headers['user-agent'] || '', /CairnCorpus\/1\.0/);

      assert.equal(runtime.index.stats().docs, docsBefore, 'corpus crawl must not touch the search index');
      assert.ok(!runtime.index.list({ limit: 1000 }).docs.some((d) => d.url.startsWith(corpusSite.url)));
      const corpusFile = path.join(tmp, 'corpus', `${res.id}.jsonl`);
      const collected = fs.existsSync(corpusFile) ? fs.readFileSync(corpusFile, 'utf8').trim() : '';
      assert.equal(collected, '', 'nothing may be collected into the corpus');
    });
  });

  describe('server + user-triggered fetch', () => {
    before(async () => {
      server = await startServer({ runtime, port: 0 });
    });

    it('publishes the key directory at the Signature-Agent URL', async () => {
      assert.equal(runtime.config.publicBaseUrl, server.url, 'publicBaseUrl follows the bound port');
      const res = await fetch(server.url + '/.well-known/http-message-signatures-directory');
      assert.equal(res.status, 200);
      const jwks = await res.json();
      assert.ok(jwks.keys.some((k) => k.kid === runtime.signer.keyId));
    });

    it('rejects an unsigned request to /signed-only', async () => {
      const res = await fetch(u('/signed-only'));
      assert.equal(res.status, 401);
    });

    it('verifies Web Bot Auth on a user fetch of /signed-only', async () => {
      site.reset();
      const result = await runtime.fetcher.fetch(u('/signed-only'), { role: 'user' });
      assert.equal(result.status, 200, `signed-only returned ${result.status}: ${result.body}`);
      assert.equal(result.signed, true);
      const body = JSON.parse(result.body);
      assert.equal(body.verified, true);
      assert.equal(body.keyid, runtime.signer.keyId);
      assert.equal(body.agent, server.url);

      const req = site.requests.find((r) => r.path === '/signed-only');
      assert.match(req.headers['user-agent'], /Cairn-User\/1\.0/);
      assert.ok(req.headers['user-agent'].includes(`+${server.url}/bot`), 'UA links the live /bot page');
    });

    it('exposes the same verified fetch through POST /api/fetch', async () => {
      const res = await fetch(server.url + '/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u('/signed-only'), role: 'user' }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.result.status, 200);
      assert.equal(json.result.signed, true);
    });

    it('refuses a user fetch of a robots-disallowed page by default', async () => {
      site.reset();
      const result = await runtime.fetcher.fetch(u('/private/secret.html'), { role: 'user' });
      assert.equal(result.ok, false);
      assert.equal(result.blocked?.reason, 'robots');
      assert.ok(!requested(site.requests, '/private/secret.html'));
    });
  });

  describe('quick answer (fake Claude CLI)', () => {
    it('answers from indexed passages with citations', async () => {
      const res = await answerQuestion('How much does the Ridgeback 45 weigh and what is the return window?', { runtime });
      assert.equal(res.mode, 'quick');
      assert.equal(res.usedClaude, true, 'fake Claude CLI should have been used');
      assert.ok(typeof res.answer === 'string' && res.answer.length > 0);
      assert.match(res.answer, /\[\d+\]/, 'answer cites sources');
      assert.ok(res.citations.length >= 1, 'at least one citation');
      for (const c of res.citations) assert.ok(c.url.startsWith(site.url), `citation outside fixture: ${c.url}`);
      const passages = Array.isArray(res.passages) ? res.passages.length : res.passages;
      assert.ok(passages >= 1, 'retrieval returned passages');
    });
  });
});
