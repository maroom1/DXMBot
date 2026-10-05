import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrawlJob } from '../src/crawl/crawler.js';
import { JobManager } from '../src/crawl/jobs.js';
import { CorpusWriter, corpusFile, readCorpus } from '../src/crawl/corpus.js';
import { AuditLog } from '../src/util/audit.js';

const SITE = 'http://site.test';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-crawl-'));
}

function makeConfig(crawl = {}) {
  return {
    dataDir: tmpDir(),
    crawl: { maxPages: 50, maxDepth: 3, sameSiteOnly: true, useSitemaps: false, concurrency: 3, ...crawl },
  };
}

// Minimal HTML page builder.
function page({ title = 'Page', text, links = [], head = '' } = {}) {
  const anchors = links
    .map((l) => (typeof l === 'string' ? `<a href="${l}">${l}</a>` : `<a href="${l.href}" rel="${l.rel}">${l.href}</a>`))
    .join('\n');
  return `<!doctype html><html><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${
    text ?? `Unique body text for ${title}.`
  }</p>${anchors}</body></html>`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

// In-memory stand-in for the Fetcher. `pages` maps absolute URL → string (HTML
// body) or {body, type, status, redirect, xRobotsTag}.
function fakeFetcher(pages, { sitemaps = [], disallow = () => false, delayMs = 0 } = {}) {
  const requests = [];
  const robotsCalls = [];
  const fetcher = {
    requests,
    robotsCalls,
    robots: {
      async get(url, role) {
        robotsCalls.push({ url, role });
        return { robots: { sitemaps } };
      },
    },
    async checkRobots(url, role) {
      return { allowed: !disallow(url, role), rule: null };
    },
    async fetch(url, { role = 'search', signal } = {}) {
      const base = { url, finalUrl: url, headers: {}, redirects: [], role, error: null, truncated: false, signed: false };
      if (disallow(url, role)) {
        return { ...base, ok: false, status: null, body: null, contentType: null, blocked: { reason: 'robots', detail: 'disallowed' } };
      }
      requests.push(url);
      if (delayMs) await sleep(delayMs, signal);
      let entry = pages[url];
      let finalUrl = url;
      if (entry && typeof entry === 'object' && entry.redirect) {
        finalUrl = entry.redirect;
        entry = pages[finalUrl];
      }
      if (entry === undefined) {
        return { ...base, ok: false, status: 404, body: 'Not found', contentType: 'text/html', blocked: null };
      }
      const e = typeof entry === 'string' ? { body: entry } : entry;
      const status = e.status ?? 200;
      return {
        ...base,
        finalUrl,
        ok: status >= 200 && status < 300,
        status,
        body: e.body,
        contentType: e.type ?? 'text/html; charset=utf-8',
        blocked: null,
        xRobotsTag: { noindex: false, nofollow: false, noarchive: false, nosnippet: false, ...(e.xRobotsTag || {}) },
      };
    },
  };
  return fetcher;
}

class FakeIndex {
  docs = new Map();
  saves = 0;
  add(doc) {
    const prev = this.docs.get(doc.url);
    this.docs.set(doc.url, doc);
    if (!prev) return 'added';
    return prev.contentHash === doc.contentHash ? 'unchanged' : 'updated';
  }
  has(url) {
    return this.docs.has(url);
  }
  get(url) {
    return this.docs.get(url) ?? null;
  }
  findByHash(hash) {
    for (const d of this.docs.values()) if (d.contentHash === hash) return d.url;
    return null;
  }
  scheduleSave() {
    this.saves++;
  }
}

// Throws on any use: proves the corpus role never touches the search index.
function untouchableIndex() {
  const touched = [];
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        touched.push(prop);
        throw new Error(`index.${String(prop)} must not be used by a corpus crawl`);
      },
    },
  );
  return { proxy, touched };
}

async function crawl(pages, opts = {}, { fetcherOpts, index = new FakeIndex(), config = makeConfig(), audit } = {}) {
  const fetcher = fakeFetcher(pages, fetcherOpts);
  const job = new CrawlJob({ seeds: [`${SITE}/`], ...opts }, { config, fetcher, index, audit });
  const pageEvents = [];
  job.on('page', (p) => pageEvents.push(p));
  const status = await job.run();
  const outcome = (url) => pageEvents.find((p) => p.url === url)?.outcome;
  return { job, status, fetcher, index, pageEvents, outcome, config };
}

test('depth limit: links beyond maxDepth are not fetched', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/a.html'] }),
    [`${SITE}/a.html`]: page({ title: 'A', links: ['/b.html'] }),
    [`${SITE}/b.html`]: page({ title: 'B', links: ['/c.html'] }),
    [`${SITE}/c.html`]: page({ title: 'C' }),
  };
  const { status, fetcher, index, pageEvents } = await crawl(pages, { maxDepth: 2 });
  assert.deepEqual(fetcher.requests.sort(), [`${SITE}/`, `${SITE}/a.html`, `${SITE}/b.html`]);
  assert.equal(status.state, 'done');
  assert.equal(status.counts.indexed, 3);
  assert.ok(!index.has(`${SITE}/c.html`));
  assert.deepEqual(
    pageEvents.map((p) => [p.url, p.depth]).sort(),
    [
      [`${SITE}/`, 0],
      [`${SITE}/a.html`, 1],
      [`${SITE}/b.html`, 2],
    ],
  );
});

test('maxPages caps the number of page fetch attempts', async () => {
  const links = Array.from({ length: 20 }, (_, i) => `/p${i}.html`);
  const pages = { [`${SITE}/`]: page({ title: 'Home', links }) };
  for (const l of links) pages[`${SITE}${l}`] = page({ title: l });
  const { status, fetcher } = await crawl(pages, { maxPages: 5, concurrency: 4 });
  assert.equal(fetcher.requests.length, 5);
  assert.equal(status.counts.fetched, 5);
  assert.equal(status.counts.indexed, 5);
  assert.equal(status.counts.discovered, 21);
  assert.equal(status.counts.queued, 16);
});

test('sameSiteOnly keeps the crawl on the seed site (www. is the same site)', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['http://www.site.test/w.html', 'http://other.test/x.html'] }),
    'http://www.site.test/w.html': page({ title: 'W' }),
    'http://other.test/x.html': page({ title: 'X' }),
  };
  const scoped = await crawl(pages, {});
  assert.ok(scoped.fetcher.requests.includes('http://www.site.test/w.html'));
  assert.ok(!scoped.fetcher.requests.includes('http://other.test/x.html'));

  const open = await crawl(pages, { sameSiteOnly: false });
  assert.ok(open.fetcher.requests.includes('http://other.test/x.html'));
  assert.equal(open.status.counts.indexed, 3);
});

test('include/exclude patterns scope discovered URLs', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/blog/1.html', '/blog/draft-2.html', '/shop/x.html'] }),
    [`${SITE}/blog/1.html`]: page({ title: 'B1' }),
    [`${SITE}/blog/draft-2.html`]: page({ title: 'B2' }),
    [`${SITE}/shop/x.html`]: page({ title: 'S' }),
  };
  const { fetcher, status } = await crawl(pages, { includePatterns: ['/blog/'], excludePatterns: ['draft'] });
  assert.deepEqual(fetcher.requests.sort(), [`${SITE}/`, `${SITE}/blog/1.html`]);
  assert.deepEqual(status.options.includePatterns, ['/blog/']);
  assert.deepEqual(status.options.excludePatterns, ['draft']);
  assert.throws(() => new CrawlJob({ seeds: [SITE], includePatterns: ['('] }, { config: makeConfig(), fetcher: fakeFetcher({}), index: new FakeIndex() }), /Invalid include pattern/);
});

test('page-level nofollow and rel=nofollow links are not followed', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/nofollow.html', '/rel.html'] }),
    [`${SITE}/nofollow.html`]: page({ title: 'NF', head: '<meta name="robots" content="nofollow">', links: ['/hidden-1.html'] }),
    [`${SITE}/rel.html`]: page({ title: 'Rel', links: [{ href: '/hidden-2.html', rel: 'nofollow' }, '/visible.html'] }),
    [`${SITE}/hidden-1.html`]: page({ title: 'H1' }),
    [`${SITE}/hidden-2.html`]: page({ title: 'H2' }),
    [`${SITE}/visible.html`]: page({ title: 'V' }),
  };
  const { fetcher, outcome, index } = await crawl(pages, {});
  assert.ok(!fetcher.requests.includes(`${SITE}/hidden-1.html`));
  assert.ok(!fetcher.requests.includes(`${SITE}/hidden-2.html`));
  assert.ok(fetcher.requests.includes(`${SITE}/visible.html`));
  // nofollow alone does not prevent indexing
  assert.equal(outcome(`${SITE}/nofollow.html`), 'indexed');
  assert.ok(index.has(`${SITE}/nofollow.html`));
});

test('noindex (meta or X-Robots-Tag) is not indexed but its links are followed', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/noindex.html', '/xrobots.html'] }),
    [`${SITE}/noindex.html`]: page({ title: 'NI', head: '<meta name="robots" content="noindex">', links: ['/via-noindex.html'] }),
    [`${SITE}/xrobots.html`]: { body: page({ title: 'XR', links: ['/via-xrobots.html'] }), xRobotsTag: { noindex: true } },
    [`${SITE}/via-noindex.html`]: page({ title: 'Via NI' }),
    [`${SITE}/via-xrobots.html`]: page({ title: 'Via XR' }),
  };
  const { status, index, outcome } = await crawl(pages, {});
  assert.equal(outcome(`${SITE}/noindex.html`), 'noindex');
  assert.equal(outcome(`${SITE}/xrobots.html`), 'noindex');
  assert.ok(!index.has(`${SITE}/noindex.html`));
  assert.ok(!index.has(`${SITE}/xrobots.html`));
  assert.ok(index.has(`${SITE}/via-noindex.html`));
  assert.ok(index.has(`${SITE}/via-xrobots.html`));
  assert.equal(status.counts.noindex, 2);
});

test('bot-specific meta tag for the role token is honoured', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/bot-noindex.html'] }),
    [`${SITE}/bot-noindex.html`]: page({ title: 'Bot NI', head: '<meta name="CairnSearch" content="noindex">' }),
  };
  const { outcome } = await crawl(pages, {});
  assert.equal(outcome(`${SITE}/bot-noindex.html`), 'noindex');
});

test('canonical pointing at an already seen page is a duplicate', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/about.html', '/canonical-dup.html'] }),
    [`${SITE}/about.html`]: page({ title: 'About', text: 'About us.' }),
    [`${SITE}/canonical-dup.html`]: page({
      title: 'About (print)',
      text: 'About us, printable.',
      head: `<link rel="canonical" href="${SITE}/about.html">`,
    }),
  };
  const { status, index, outcome } = await crawl(pages, {});
  assert.equal(outcome(`${SITE}/canonical-dup.html`), 'duplicate');
  assert.equal(outcome(`${SITE}/about.html`), 'indexed');
  assert.ok(!index.has(`${SITE}/canonical-dup.html`));
  assert.equal(status.counts.duplicates, 1);

  // Canonical already in the index from an earlier crawl → duplicate as well.
  const idx = new FakeIndex();
  idx.add({ url: 'http://site.test/elsewhere.html', contentHash: 'x' });
  const again = await crawl(
    { [`${SITE}/`]: page({ title: 'Home', head: '<link rel="canonical" href="/elsewhere.html">' }) },
    { maxDepth: 0 },
    { index: idx },
  );
  assert.equal(again.outcome(`${SITE}/`), 'duplicate');
});

test('identical content under two URLs is a content-hash duplicate', async () => {
  const same = 'Exactly the same body text on both pages.';
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/post-1.html', '/dup-content.html'] }),
    [`${SITE}/post-1.html`]: page({ title: 'Post', text: same }),
    [`${SITE}/dup-content.html`]: page({ title: 'Post', text: same }),
  };
  const { status, index, outcome } = await crawl(pages, { concurrency: 1 });
  assert.equal(outcome(`${SITE}/post-1.html`), 'indexed');
  assert.equal(outcome(`${SITE}/dup-content.html`), 'duplicate');
  assert.ok(!index.has(`${SITE}/dup-content.html`));
  assert.equal(status.counts.duplicates, 1);
  const doc = index.get(`${SITE}/post-1.html`);
  assert.match(doc.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(doc.site, 'site.test');
  assert.equal(doc.role, 'search');
  assert.ok(index.saves > 0, 'scheduleSave called');
});

test('sitemap index recursion discovers an orphan page (depth 1)', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/about.html'] }),
    [`${SITE}/about.html`]: page({ title: 'About' }),
    [`${SITE}/orphan.html`]: page({ title: 'Orphan' }),
    [`${SITE}/deep-orphan.html`]: page({ title: 'Deep orphan' }),
    [`${SITE}/sitemap_index.xml`]: {
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE}/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>${SITE}/sitemap-more.xml</loc></sitemap>
</sitemapindex>`,
    },
    [`${SITE}/sitemap-pages.xml`]: {
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/about.html</loc></url>
  <url><loc>${SITE}/orphan.html</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>http://elsewhere.test/not-ours.html</loc></url>
</urlset>`,
    },
    [`${SITE}/sitemap-more.xml`]: {
      type: 'application/xml',
      body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE}/sitemap-deep.xml</loc></sitemap></sitemapindex>`,
    },
    [`${SITE}/sitemap-deep.xml`]: {
      type: 'application/xml',
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/deep-orphan.html</loc></url></urlset>`,
    },
  };
  const { status, index, pageEvents, fetcher } = await crawl(
    pages,
    { useSitemaps: true },
    { fetcherOpts: { sitemaps: [`${SITE}/sitemap_index.xml`] } },
  );
  assert.equal(status.state, 'done');
  assert.ok(index.has(`${SITE}/orphan.html`), 'orphan found via nested sitemap');
  assert.ok(index.has(`${SITE}/deep-orphan.html`), 'third sitemap level is followed');
  assert.equal(pageEvents.find((p) => p.url === `${SITE}/orphan.html`).depth, 1);
  assert.ok(!fetcher.requests.includes('http://elsewhere.test/not-ours.html'));
  assert.ok(fetcher.requests.includes(`${SITE}/sitemap.xml`), 'default /sitemap.xml is tried too');
  assert.ok(fetcher.robotsCalls.length >= 1);
  // sitemap files are not page fetch attempts and never show up as pages
  assert.ok(!pageEvents.some((p) => p.url.endsWith('.xml')));
  assert.equal(status.counts.fetched, 4);
});

test('useSitemaps=false never fetches sitemaps', async () => {
  const pages = { [`${SITE}/`]: page({ title: 'Home' }), [`${SITE}/sitemap.xml`]: { type: 'application/xml', body: '<urlset/>' } };
  const { fetcher } = await crawl(pages, { useSitemaps: false }, { fetcherOpts: { sitemaps: [`${SITE}/sitemap.xml`] } });
  assert.deepEqual(fetcher.requests, [`${SITE}/`]);
});

test('robots-blocked URLs are counted as blockedRobots and never requested', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/private/secret.html', '/public.html'] }),
    [`${SITE}/private/secret.html`]: page({ title: 'Secret' }),
    [`${SITE}/public.html`]: page({ title: 'Public' }),
  };
  const disallow = (url) => new URL(url).pathname.startsWith('/private/');
  const { status, fetcher, outcome, index } = await crawl(pages, {}, { fetcherOpts: { disallow } });
  assert.equal(outcome(`${SITE}/private/secret.html`), 'blocked-robots');
  assert.equal(status.counts.blockedRobots, 1);
  assert.ok(!fetcher.requests.includes(`${SITE}/private/secret.html`));
  assert.ok(!index.has(`${SITE}/private/secret.html`));
  assert.equal(status.recent.find((r) => r.url === `${SITE}/private/secret.html`).status, null);
});

test('non-HTML types are skipped, text/plain is indexed, HTTP errors are counted', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/file.pdf', '/data.json', '/logo.png', '/notes.txt', '/missing.html', '/redirect'] }),
    [`${SITE}/file.pdf`]: { type: 'application/pdf', body: '%PDF-1.4' },
    [`${SITE}/data.json`]: { type: 'application/json', body: '{"a":1}' },
    [`${SITE}/logo.png`]: { type: 'image/png', body: 'PNG' },
    [`${SITE}/notes.txt`]: { type: 'text/plain; charset=utf-8', body: 'Plain notes\nThe Ridgeback 45 weighs 1.2 kg.' },
    [`${SITE}/redirect`]: { redirect: `${SITE}/target.html` },
    [`${SITE}/target.html`]: page({ title: 'Target' }),
  };
  const { status, index, outcome } = await crawl(pages, {});
  assert.equal(outcome(`${SITE}/file.pdf`), 'skipped-type');
  assert.equal(outcome(`${SITE}/data.json`), 'skipped-type');
  assert.equal(outcome(`${SITE}/logo.png`), 'skipped-type');
  assert.equal(outcome(`${SITE}/notes.txt`), 'indexed');
  assert.equal(outcome(`${SITE}/missing.html`), 'http-404');
  assert.equal(status.counts.skipped, 3);
  assert.equal(status.counts.errors, 1);
  assert.ok(index.has(`${SITE}/notes.txt`));
  assert.match(index.get(`${SITE}/notes.txt`).text, /1\.2 kg/);
  // redirects are indexed under the final URL
  assert.equal(outcome(`${SITE}/redirect`), 'indexed');
  assert.ok(index.has(`${SITE}/target.html`));
  assert.ok(!index.has(`${SITE}/redirect`));
});

test('corpus role writes JSONL and never touches the search index', async () => {
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', links: ['/a.html', '/noindex.html'] }),
    [`${SITE}/a.html`]: page({ title: 'A', text: 'Alpha text.' }),
    [`${SITE}/noindex.html`]: page({ title: 'NI', head: '<meta name="robots" content="noindex">' }),
  };
  const { proxy, touched } = untouchableIndex();
  const audit = new AuditLog();
  const { status, job, config } = await crawl(pages, { role: 'corpus' }, { index: proxy, audit });
  assert.equal(status.state, 'done', status.error);
  assert.equal(status.role, 'corpus');
  assert.deepEqual(touched, []);
  assert.equal(status.counts.collected, 2);
  assert.equal(status.counts.indexed, 0);
  const file = path.join(config.dataDir, 'corpus', `${job.id}.jsonl`);
  assert.equal(corpusFile(config.dataDir, job.id), file);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const rec of lines) assert.deepEqual(Object.keys(rec).sort(), ['contentHash', 'fetchedAt', 'text', 'title', 'url']);
  assert.ok(lines.some((r) => r.url === `${SITE}/a.html` && /Alpha text/.test(r.text)));
  const crawlEntries = audit.recent({ kind: 'crawl' });
  assert.deepEqual(crawlEntries.map((e) => e.event).sort(), ['finish', 'start']);
  assert.ok(crawlEntries.every((e) => e.jobId === job.id));
});

test('search role rejects user role and requires seeds', () => {
  const deps = { config: makeConfig(), fetcher: fakeFetcher({}), index: new FakeIndex() };
  assert.throws(() => new CrawlJob({ seeds: [SITE], role: 'user' }, deps), /role/);
  assert.throws(() => new CrawlJob({ seeds: ['ftp://x'] }, deps), /seed/);
});

test('cancel mid-run ends the job in state cancelled', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `/slow-${i}.html`);
  const pages = { [`${SITE}/`]: page({ title: 'Home', links }) };
  for (const l of links) pages[`${SITE}${l}`] = page({ title: l });
  const fetcher = fakeFetcher(pages, { delayMs: 40 });
  const job = new CrawlJob({ seeds: [`${SITE}/`], concurrency: 2 }, { config: makeConfig(), fetcher, index: new FakeIndex() });
  const states = [];
  job.on('state', (s) => states.push(s.state));
  let pagesSeen = 0;
  job.on('page', () => {
    if (++pagesSeen === 2) job.cancel();
  });
  const started = Date.now();
  const status = await job.run();
  assert.equal(status.state, 'cancelled');
  assert.ok(status.finishedAt);
  assert.deepEqual(status.inFlight, []);
  assert.ok(status.counts.fetched < 31, 'stopped early');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(states, ['running', 'cancelled']);
  // cancelling a finished job is a no-op
  assert.equal(job.cancel().state, 'cancelled');
});

test('page, state and done events carry the SPEC payloads', async () => {
  const pages = { [`${SITE}/`]: page({ title: 'Home', links: ['/a.html'] }), [`${SITE}/a.html`]: page({ title: 'A' }) };
  const fetcher = fakeFetcher(pages);
  const job = new CrawlJob({ seeds: [`${SITE}/`] }, { config: makeConfig(), fetcher, index: new FakeIndex() });
  const events = [];
  job.on('page', (p) => events.push(['page', p]));
  job.on('state', (s) => events.push(['state', s.state]));
  job.on('done', (s) => events.push(['done', s]));
  await job.run();
  const pageEvents = events.filter(([e]) => e === 'page').map(([, p]) => p);
  assert.equal(pageEvents.length, 2);
  assert.deepEqual(Object.keys(pageEvents[0]).sort(), ['depth', 'jobId', 'outcome', 'status', 'title', 'url']);
  assert.deepEqual(pageEvents[0], { jobId: job.id, url: `${SITE}/`, outcome: 'indexed', status: 200, title: 'Home', depth: 0 });
  const done = events.filter(([e]) => e === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0][1].state, 'done');
  assert.deepEqual(events.filter(([e]) => e === 'state').map(([, s]) => s), ['running', 'done']);
  assert.equal(events.at(-1)[0], 'done');
});

test('status() has exactly the SPEC shape', async () => {
  const pages = { [`${SITE}/`]: page({ title: 'Home' }) };
  const job = new CrawlJob({ id: 'job-shape', seeds: [`${SITE}/`], maxPages: 7 }, { config: makeConfig(), fetcher: fakeFetcher(pages), index: new FakeIndex() });
  const before = job.status();
  assert.equal(before.state, 'queued');
  assert.equal(before.startedAt, null);
  const s = await job.run();
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'error', 'finishedAt', 'id', 'inFlight', 'options', 'recent', 'role', 'seeds', 'startedAt', 'state'].sort());
  assert.deepEqual(Object.keys(s.counts).sort(), ['blockedRobots', 'collected', 'discovered', 'duplicates', 'errors', 'fetched', 'indexed', 'noindex', 'queued', 'skipped'].sort());
  assert.equal(s.id, 'job-shape');
  assert.equal(s.role, 'search');
  assert.deepEqual(s.seeds, [`${SITE}/`]);
  assert.equal(s.options.maxPages, 7);
  assert.equal(s.options.maxDepth, 3); // from config.crawl
  assert.equal(typeof s.options.sameSiteOnly, 'boolean');
  assert.equal(typeof s.options.useSitemaps, 'boolean');
  assert.equal(typeof s.options.concurrency, 'number');
  assert.ok(!Number.isNaN(Date.parse(s.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(s.finishedAt)));
  assert.ok(Array.isArray(s.inFlight));
  assert.equal(s.error, null);
  assert.equal(s.recent.length, 1);
  assert.deepEqual(Object.keys(s.recent[0]).sort(), ['depth', 'outcome', 'status', 'title', 'ts', 'url']);
  assert.deepEqual(JSON.parse(JSON.stringify(job)), JSON.parse(JSON.stringify(s)), 'toJSON() is status()');
});

test('recent keeps only the last 50 pages', async () => {
  const links = Array.from({ length: 60 }, (_, i) => `/r${i}.html`);
  const pages = { [`${SITE}/`]: page({ title: 'Home', links }) };
  for (const l of links) pages[`${SITE}${l}`] = page({ title: l });
  const { status } = await crawl(pages, { maxPages: 100, concurrency: 8 });
  assert.equal(status.counts.fetched, 61);
  assert.equal(status.recent.length, 50);
});

test('JobManager create/list/get/cancel/waitFor', async () => {
  const pages = { [`${SITE}/`]: page({ title: 'Home', links: ['/a.html'] }), [`${SITE}/a.html`]: page({ title: 'A' }) };
  const slowLinks = Array.from({ length: 20 }, (_, i) => `/s${i}.html`);
  const slowPages = { 'http://slow.test/': page({ title: 'Slow', links: slowLinks }) };
  for (const l of slowLinks) slowPages[`http://slow.test${l}`] = page({ title: l });
  const fast = fakeFetcher(pages);
  const slow = fakeFetcher(slowPages, { delayMs: 30 });
  const fetcher = { ...fast, fetch: (url, o) => (url.startsWith('http://slow.test') ? slow.fetch(url, o) : fast.fetch(url, o)) };
  const index = new FakeIndex();
  const audit = new AuditLog();
  const jobs = new JobManager({ config: makeConfig(), fetcher, index, audit });

  const a = jobs.create({ seeds: [`${SITE}/`] });
  assert.match(a.id, /^job-\d+-[0-9a-z]+$/);
  assert.equal(a.status().state, 'running', 'starts immediately');
  const b = jobs.create({ seeds: ['http://slow.test/'], concurrency: 1 });
  assert.notEqual(a.id, b.id);
  assert.equal(jobs.get(a.id), a);
  assert.equal(jobs.get('nope'), null);
  assert.deepEqual(jobs.list().map((s) => s.id), [b.id, a.id], 'newest first');

  const doneA = await jobs.waitFor(a.id, 5000);
  assert.equal(doneA.state, 'done');
  assert.equal(doneA.counts.indexed, 2);

  const cancelled = jobs.cancel(b.id);
  assert.ok(cancelled);
  const doneB = await jobs.waitFor(b.id, 5000);
  assert.equal(doneB.state, 'cancelled');
  assert.equal(jobs.cancel('nope'), null);
  await assert.rejects(() => jobs.waitFor('nope', 10), /Unknown/);

  // waitFor times out with the current status rather than rejecting
  const c = jobs.create({ seeds: ['http://slow.test/'], concurrency: 1 });
  const early = await jobs.waitFor(c.id, 20);
  assert.equal(early.state, 'running');
  jobs.cancelAll();
  assert.equal((await jobs.waitFor(c.id, 5000)).state, 'cancelled');

  assert.throws(() => jobs.create({ seeds: ['not a url'] }), /seed/);
  assert.equal(audit.recent({ kind: 'crawl' }).filter((e) => e.event === 'start').length, 3);
});

test('JobManager keeps at most 50 jobs', async () => {
  const jobs = new JobManager({ config: makeConfig({ useSitemaps: false }), fetcher: fakeFetcher({ [`${SITE}/`]: page({ title: 'Home' }) }), index: new FakeIndex() });
  const created = [];
  for (let i = 0; i < 55; i++) {
    const job = jobs.create({ seeds: [`${SITE}/`], maxDepth: 0 });
    created.push(job.id);
    await jobs.waitFor(job.id, 1000);
  }
  const list = jobs.list();
  assert.equal(list.length, 50);
  assert.equal(list[0].id, created.at(-1));
  assert.equal(jobs.get(created[0]), null);
});

test('CorpusWriter serializes appends and readCorpus reads them back', async () => {
  const dataDir = tmpDir();
  const w = new CorpusWriter({ dataDir, jobId: '../evil/id' });
  assert.ok(w.file.startsWith(path.join(dataDir, 'corpus') + path.sep), 'job id cannot escape corpus dir');
  await Promise.all(Array.from({ length: 10 }, (_, i) => w.append({ url: `${SITE}/${i}`, title: `T${i}`, text: 'x', fetchedAt: 'now', contentHash: 'h' })));
  await w.flush();
  const recs = await readCorpus(w.file);
  assert.deepEqual(recs.map((r) => r.url), Array.from({ length: 10 }, (_, i) => `${SITE}/${i}`));
  assert.deepEqual(await readCorpus(path.join(dataDir, 'missing.jsonl')), []);
});

test('works with the real SearchIndex when available', async (t) => {
  let SearchIndex;
  try {
    ({ SearchIndex } = await import('../src/index/store.js'));
  } catch {
    t.skip('src/index/store.js not available');
    return;
  }
  const same = 'Identical words for the hash duplicate check across two pages.';
  const pages = {
    [`${SITE}/`]: page({ title: 'Home', text: 'Northwind Trails home page.', links: ['/one.html', '/two.html'] }),
    [`${SITE}/one.html`]: page({ title: 'Same', text: same }),
    [`${SITE}/two.html`]: page({ title: 'Same', text: same }),
  };
  const index = new SearchIndex({ file: null });
  const { status } = await crawl(pages, { concurrency: 1 }, { index });
  assert.equal(status.state, 'done', status.error);
  assert.equal(status.counts.indexed, 2);
  assert.equal(status.counts.duplicates, 1);
  assert.ok(index.has(`${SITE}/`));
});

class RemovableIndex extends FakeIndex {
  remove(url) {
    return this.docs.delete(url);
  }
}

test('pages that become noindex, robots-disallowed (real rule) or 404/410 leave the index', async () => {
  const index = new RemovableIndex();
  const urls = ['/a.html', '/b.html', '/c.html', '/d.html', '/e.html'].map((p) => `${SITE}${p}`);
  const home = page({ title: 'Home', links: urls });
  const first = Object.fromEntries([[`${SITE}/`, home], ...urls.map((u, i) => [u, page({ title: `P${i}` })])]);
  await crawl(first, { maxDepth: 1 }, { index });
  for (const u of urls) assert.ok(index.has(u), u);

  const second = {
    [`${SITE}/`]: home,
    [urls[0]]: page({ title: 'P0', head: '<meta name="robots" content="noindex">' }),
    [urls[1]]: { body: 'gone', status: 410 },
    // urls[2] missing → 404
    [urls[3]]: page({ title: 'P3' }),
    [urls[4]]: page({ title: 'P4' }),
  };
  const base = fakeFetcher(second);
  const blocked = (url, note) => ({ url, finalUrl: url, ok: false, status: null, body: null, headers: {}, blocked: { reason: 'robots', detail: 'x', robots: { allowed: false, rule: { type: 'disallow', path: '/' }, note } } });
  const wrapped = {
    ...base,
    async fetch(url, opts) {
      if (url === urls[3]) return blocked(url, null); // real Disallow rule
      if (url === urls[4]) return blocked(url, 'robots.txt unreachable (HTTP 503); treated as disallow-all.');
      return base.fetch(url, opts);
    },
  };
  const job = new CrawlJob({ seeds: [`${SITE}/`], maxDepth: 1 }, { config: makeConfig(), fetcher: wrapped, index });
  await job.run();
  assert.equal(index.has(urls[0]), false, 'noindex');
  assert.equal(index.has(urls[1]), false, '410');
  assert.equal(index.has(urls[2]), false, '404');
  assert.equal(index.has(urls[3]), false, 'disallowed by a real rule');
  assert.equal(index.has(urls[4]), true, 'a temporary robots.txt outage does not purge the site');
});

test('frontier is bounded by the remaining budget and released when the job finishes', async () => {
  const links = Array.from({ length: 20000 }, (_, i) => `/p${i}.html`);
  const pages = { [`${SITE}/`]: page({ title: 'Home', links }) };
  const { status, job } = await crawl(pages, { maxPages: 3, maxDepth: 1 });
  assert.ok(status.counts.discovered <= 1 + 3 * 10, `discovered ${status.counts.discovered}`);
  assert.equal(job.status().counts.queued, status.counts.queued, 'queued count is kept after finish');
  assert.equal(status.state, 'done');
});
