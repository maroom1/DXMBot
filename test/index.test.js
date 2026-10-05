import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize, stem, STOPWORDS } from '../src/index/tokenize.js';
import { SearchIndex, sha256, splitPassages } from '../src/index/store.js';

const doc = (url, title, text, extra = {}) => ({ url, title, text, fetchedAt: '2026-01-01T00:00:00.000Z', ...extra });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-index-'));
}

function sampleIndex(opts) {
  const idx = new SearchIndex(opts);
  idx.add(doc('https://trails.test/products/ridgeback-45.html', 'Ridgeback 45 Backpack',
    'The Ridgeback 45 is a 45 litre pack. It weighs 1.2 kg and costs $189. Lifetime warranty on packs.'));
  idx.add(doc('https://trails.test/products/summit-shell.html', 'Summit Shell Jacket',
    'A waterproof shell jacket rated 20k mm. Pairs well with any backpack for rainy hikes. Costs $249.'));
  idx.add(doc('https://trails.test/faq.html', 'FAQ',
    'Returns are accepted within 60 days. Running shoes and backpacks can be returned unworn.'));
  idx.add(doc('https://blog.trails.test/post-1.html', 'Trail running tips',
    'We love running on mountain trails. Bring water and a light pack.'));
  idx.add(doc('https://other.test/page.html', 'Unrelated', 'Cooking pasta with tomatoes and basil.'));
  return idx;
}

// ---------------------------------------------------------------------------
// tokenize

test('tokenize: lowercase, stopwords, unicode, accents, numbers', () => {
  assert.deepEqual(tokenize('The QUICK brown Fox is in the Box'), ['quick', 'brown', 'fox', 'box']);
  assert.deepEqual(tokenize("Northwind's café — don't stop! 1.2 kg $189"), ['northwind', 'cafe', 'dont', 'stop', '1.2', 'kg', '189']);
  assert.deepEqual(tokenize('日本語 テスト Straße'), ['日本語', 'テスト', 'straße']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.ok(STOPWORDS.has('the'));
});

test('tokenize: light stemming makes plural and verb forms meet', () => {
  const same = (a, b) => assert.deepEqual(tokenize(a), tokenize(b), `${a} vs ${b}`);
  same('backpacks', 'backpack');
  same('running', 'run');
  same('runs', 'run');
  same('hiking', 'hike');
  same('hiked', 'hike');
  same('batteries', 'battery');
  same('boxes', 'box');
  same('watches', 'watch');
  same('classes', 'class');
  same('returned', 'returns');
  same('pricing', 'price');
  same('jackets', 'jacket');
  assert.equal(stem('sing'), 'sing');
  assert.equal(stem('status'), 'status');
  assert.equal(stem('need'), 'need');
  assert.equal(stem('agreed'), 'agree');
});

// ---------------------------------------------------------------------------
// SearchIndex

test('ranking: a doc with the query term in its title ranks first', () => {
  const idx = new SearchIndex();
  idx.add(doc('https://a.test/1', 'Cooking guide', 'This guide covers tents in passing. Tents are mentioned here twice: tents.'));
  idx.add(doc('https://a.test/2', 'Tents', 'Our lineup for this season.'));
  idx.add(doc('https://a.test/3', 'Stoves', 'Stoves only.'));
  const r = idx.search('tent');
  assert.equal(r.results[0].url, 'https://a.test/2');
  assert.equal(r.total, 2);
  assert.equal(r.query, 'tent');
  assert.ok(typeof r.tookMs === 'number');
  assert.ok(r.results[0].score > r.results[1].score);
});

test('search: stemming matches across forms and result shape', () => {
  const idx = sampleIndex();
  const r = idx.search('backpacks');
  assert.ok(r.total >= 3);
  assert.equal(r.results[0].url, 'https://trails.test/products/ridgeback-45.html');
  for (const res of r.results) {
    assert.deepEqual(Object.keys(res).sort(), ['fetchedAt', 'score', 'site', 'snippet', 'title', 'url']);
  }
  const run = idx.search('run');
  assert.deepEqual(run.results.map((x) => x.url).sort(), ['https://blog.trails.test/post-1.html', 'https://trails.test/faq.html']);
  assert.equal(run.results[0].url, 'https://blog.trails.test/post-1.html'); // title match wins
  assert.equal(idx.search('the and of').total, 0);
  assert.equal(idx.search('').total, 0);
  assert.equal(idx.search('zzzqqq').results.length, 0);
});

test('search: multi-term queries prefer docs matching more terms; limit/offset', () => {
  const idx = sampleIndex();
  const r = idx.search('ridgeback weight warranty');
  assert.equal(r.results[0].url, 'https://trails.test/products/ridgeback-45.html');
  const all = idx.search('backpack', { limit: 100 });
  const p1 = idx.search('backpack', { limit: 1 });
  const p2 = idx.search('backpack', { limit: 1, offset: 1 });
  assert.equal(p1.results.length, 1);
  assert.equal(p1.total, all.total);
  assert.equal(p2.results[0].url, all.results[1].url);
});

test('search: site filter (option and inline site: operator, subdomains included)', () => {
  const idx = sampleIndex();
  const bySite = idx.search('running', { site: 'blog.trails.test' });
  assert.deepEqual(bySite.results.map((r) => r.url), ['https://blog.trails.test/post-1.html']);
  const parent = idx.search('running', { site: 'www.trails.test' });
  assert.equal(parent.total, 2);
  const inline = idx.search('running site:trails.test/whatever');
  assert.equal(inline.total, 2);
  assert.equal(idx.search('running', { site: 'other.test' }).total, 0);
  assert.equal(idx.search('pasta', { site: 'https://other.test:8080/x' }).total, 1);
});

test('snippet: ~30-word window containing the query term', () => {
  const idx = new SearchIndex();
  const filler = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const text = `${filler(80, 'alpha')} The waterproof rating is twenty thousand millimetres. ${filler(80, 'omega')}`;
  idx.add(doc('https://s.test/1', 'Shell', text));
  const { snippet } = idx.search('waterproof rating').results[0];
  assert.match(snippet, /waterproof rating/);
  assert.match(snippet, /^\u{2026} /u);
  assert.match(snippet, / \u{2026}$/u);
  const wordsIn = snippet.replace(/\u{2026}/gu, '').trim().split(/\s+/);
  assert.ok(wordsIn.length <= 30 && wordsIn.length >= 20, `snippet length ${wordsIn.length}`);
  // very long docs: the snippet still finds a term far beyond the scan window
  idx.add(doc('https://s.test/big', 'Big', `${'lorem ipsum dolor sit amet. '.repeat(60000)} the needle is here`));
  assert.match(idx.search('needle').results[0].snippet, /^\u{2026} .*the needle is here$/u);
  // short docs: whole text, no ellipsis
  idx.add(doc('https://s.test/2', 'Short', 'Tiny waterproof note.'));
  assert.equal(idx.search('note').results[0].snippet, 'Tiny waterproof note.');
});

test('add: added / updated / unchanged semantics and contentHash', () => {
  const idx = new SearchIndex();
  const d = doc('https://u.test/a', 'A', 'first version text');
  assert.equal(idx.add(d), 'added');
  assert.equal(idx.add({ ...d }), 'unchanged');
  assert.equal(idx.add({ ...d, fetchedAt: '2026-02-01T00:00:00.000Z' }), 'unchanged');
  assert.equal(idx.get('https://u.test/a').fetchedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(idx.get('https://u.test/a').contentHash, sha256('first version text'));
  assert.equal(idx.add({ ...d, text: 'second version words' }), 'updated');
  assert.equal(idx.search('first').total, 0);
  assert.equal(idx.search('second').total, 1);
  assert.equal(idx.add({ ...d, text: 'second version words', title: 'New title' }), 'updated');
  assert.equal(idx.search('new title').total, 1);
  assert.equal(idx.stats().docs, 1);
  assert.throws(() => idx.add({ title: 'no url' }), TypeError);
  assert.throws(() => idx.add({ url: 'mailto:x@y.z' }), TypeError);
});

test('add: URLs are normalized for has/get/remove; defaults filled in', () => {
  const idx = new SearchIndex();
  idx.add({ url: 'https://www.n.test/p#frag', title: 'P', text: 'hello world' });
  assert.ok(idx.has('https://www.n.test/p'));
  assert.ok(idx.has('https://www.n.test/p#other'));
  const g = idx.get('https://www.n.test/p');
  assert.equal(g.site, 'n.test');
  assert.equal(g.role, 'search');
  assert.equal(g.nosnippet, false);
  assert.equal(g.wordCount, 2);
  assert.ok(!Number.isNaN(Date.parse(g.fetchedAt)));
  assert.equal(idx.get('https://nope.test/'), null);
});

test('remove and clear', () => {
  const idx = sampleIndex();
  const before = idx.stats();
  assert.equal(idx.remove('https://other.test/page.html'), true);
  assert.equal(idx.remove('https://other.test/page.html'), false);
  assert.equal(idx.has('https://other.test/page.html'), false);
  assert.equal(idx.search('pasta').total, 0);
  const after = idx.stats();
  assert.equal(after.docs, before.docs - 1);
  assert.ok(after.terms < before.terms, 'terms unique to the removed doc are dropped');
  idx.clear();
  assert.deepEqual({ ...idx.stats(), lastUpdated: null }, { docs: 0, passages: 0, terms: 0, sites: [], lastUpdated: null });
  assert.equal(idx.search('backpack').total, 0);
});

test('nosnippet: empty snippet and body text excluded from passages', () => {
  const idx = new SearchIndex();
  idx.add(doc('https://ns.test/secret', 'Secret Ridgeback notes', 'Ridgeback internal pricing details are confidential.', { nosnippet: true }));
  idx.add(doc('https://ns.test/open', 'Open', 'Ridgeback public details.'));
  const r = idx.search('ridgeback pricing');
  const secret = r.results.find((x) => x.url === 'https://ns.test/secret');
  assert.ok(secret, 'nosnippet docs are still searchable');
  assert.equal(secret.snippet, '');
  const passages = idx.searchPassages('ridgeback pricing');
  for (const p of passages) {
    assert.doesNotMatch(p.text, /confidential|internal pricing/);
    if (p.url === 'https://ns.test/secret') assert.equal(p.text, 'Secret Ridgeback notes');
  }
  assert.ok(passages.some((p) => p.url === 'https://ns.test/open'));
});

test('passages: ~120-word windows with 20-word overlap; searchPassages ranks the right passage', () => {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
  const parts = splitPassages(words.join(' '));
  assert.equal(parts.length, 3);
  assert.equal(parts[0].split(' ').length, 120);
  assert.equal(parts[1].split(' ')[0], 'w100'); // 20-word overlap
  assert.equal(parts.at(-1).split(' ').at(-1), 'w299');
  assert.deepEqual(splitPassages(''), []);
  assert.equal(splitPassages('one two').length, 1);

  const idx = new SearchIndex();
  const filler = (w) => Array.from({ length: 130 }, (_, i) => `${w}${i}`).join(' ');
  idx.add(doc('https://p.test/long', 'Long manual', `${filler('intro')} The return window is 60 days from delivery. ${filler('outro')}`));
  idx.add(doc('https://p.test/other', 'Other', 'Nothing about that topic.'));
  const res = idx.searchPassages('return window', { limit: 3 });
  assert.ok(res.length >= 1);
  assert.equal(res[0].url, 'https://p.test/long');
  assert.match(res[0].text, /return window is 60 days/);
  assert.deepEqual(Object.keys(res[0]).sort(), ['score', 'text', 'title', 'url']);
  assert.ok(res.length <= 3);
  assert.deepEqual(idx.searchPassages(''), []);
  assert.equal(idx.stats().passages, splitPassages(idx.get('https://p.test/long').text).length + 1);
});

test('findByHash, list and stats', () => {
  const idx = sampleIndex();
  const text = 'Returns are accepted within 60 days. Running shoes and backpacks can be returned unworn.';
  assert.equal(idx.findByHash(sha256(text)), 'https://trails.test/faq.html');
  assert.equal(idx.findByHash('deadbeef'), null);
  idx.add(doc('https://trails.test/dup.html', 'Dup', 'identical body', { fetchedAt: '2026-03-01T00:00:00.000Z' }));
  idx.add(doc('https://trails.test/dup2.html', 'Dup2', 'identical body', { fetchedAt: '2026-03-02T00:00:00.000Z' }));
  assert.equal(idx.findByHash(sha256('identical body')), 'https://trails.test/dup.html');
  idx.remove('https://trails.test/dup.html');
  assert.equal(idx.findByHash(sha256('identical body')), 'https://trails.test/dup2.html');

  const all = idx.list();
  assert.equal(all.total, 6);
  assert.equal(all.docs[0].url, 'https://trails.test/dup2.html'); // newest first
  assert.deepEqual(Object.keys(all.docs[0]).sort(), ['fetchedAt', 'role', 'site', 'title', 'url', 'wordCount']);
  const page = idx.list({ limit: 2, offset: 1 });
  assert.equal(page.docs.length, 2);
  assert.equal(page.docs[0].url, all.docs[1].url);
  assert.equal(idx.list({ site: 'other.test' }).total, 1);

  const s = idx.stats();
  assert.equal(s.docs, 6);
  assert.ok(s.passages >= 6);
  assert.ok(s.terms > 20);
  assert.deepEqual(s.sites, [
    { site: 'trails.test', docs: 4 },
    { site: 'blog.trails.test', docs: 1 },
    { site: 'other.test', docs: 1 },
  ]);
  assert.ok(Date.parse(s.lastUpdated) > 0);
});

test('save/load roundtrip in a tmp dir (atomic, postings rebuilt)', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'nested', 'index.json');
    const idx = sampleIndex({ file });
    idx.add(doc('https://trails.test/ns', 'Hidden', 'nosnippet body', { nosnippet: true, markdown: '# Hidden', headings: [{ level: 1, text: 'Hidden' }] }));
    await idx.save();
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['index.json'], 'no temp files left behind');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(json.docs.length, 6);
    assert.equal(json.docs[0].postings, undefined);

    const copy = new SearchIndex({ file });
    await copy.load();
    assert.deepEqual(copy.stats(), idx.stats());
    assert.deepEqual(copy.search('backpack').results, idx.search('backpack').results.map((r) => ({ ...r })));
    assert.deepEqual(copy.get('https://trails.test/ns'), idx.get('https://trails.test/ns'));
    assert.equal(copy.add(idx.get('https://trails.test/faq.html')), 'unchanged');

    // load() replaces current contents; a missing file is an empty index
    const empty = new SearchIndex({ file: path.join(dir, 'missing.json') });
    empty.add(doc('https://x.test/', 'x', 'x'));
    await empty.load();
    assert.equal(empty.stats().docs, 1, 'missing file leaves the index untouched');
    await copy.load();
    assert.equal(copy.stats().docs, 6);

    // corrupt files are moved aside instead of crashing startup
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    const errors = [];
    const origError = console.error;
    console.error = (m) => errors.push(m);
    try {
      const b = new SearchIndex({ file: bad });
      await b.load();
      assert.equal(b.stats().docs, 0);
    } finally {
      console.error = origError;
    }
    assert.equal(errors.length, 1);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('bad.json.corrupt-')));

    // index without a file: save/load are no-ops
    const mem = new SearchIndex();
    await mem.save();
    await mem.load();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scheduleSave is debounced', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'index.json');
    const idx = new SearchIndex({ file });
    let writes = 0;
    const real = idx._writeSnapshot.bind(idx);
    idx._writeSnapshot = async () => {
      writes++;
      return real();
    };
    for (let i = 0; i < 5; i++) {
      idx.add(doc(`https://d.test/${i}`, `Doc ${i}`, `body ${i}`));
      idx.scheduleSave(40);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(writes, 0);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(writes, 1);
    const loaded = new SearchIndex({ file });
    await loaded.load();
    assert.equal(loaded.stats().docs, 5);

    // explicit save cancels a pending scheduled one
    idx.scheduleSave(40);
    await idx.save();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(writes, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent saves are serialized and leave a valid file', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'index.json');
    const idx = new SearchIndex({ file });
    const saves = [];
    for (let i = 0; i < 10; i++) {
      idx.add(doc(`https://c.test/${i}`, `C ${i}`, `text ${i}`));
      saves.push(idx.save());
    }
    await Promise.all(saves);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).docs.length, 10);
    assert.deepEqual(fs.readdirSync(dir), ['index.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('perf: 2000 synthetic docs index quickly and search in < 50 ms', () => {
  const vocab = Array.from({ length: 3000 }, (_, i) => `term${i.toString(36)}`);
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = () => vocab[Math.floor(rand() ** 2 * vocab.length)];
  const idx = new SearchIndex();
  const t0 = performance.now();
  for (let d = 0; d < 2000; d++) {
    const words = Array.from({ length: 150 + Math.floor(rand() * 250) }, pick);
    idx.add({ url: `https://perf${d % 20}.test/doc/${d}`, title: `${pick()} ${pick()} guide`, text: words.join(' ') });
  }
  const indexMs = performance.now() - t0;
  assert.equal(idx.stats().docs, 2000);
  assert.ok(indexMs < 10000, `indexing took ${indexMs.toFixed(0)} ms`);

  idx.search('term0 term1'); // warm-up (JIT)
  const t1 = performance.now();
  const r = idx.search('term0 term1 term2 guide');
  const searchMs = performance.now() - t1;
  assert.ok(r.total > 100);
  assert.equal(r.results.length, 10);
  assert.ok(searchMs < 50, `search took ${searchMs.toFixed(1)} ms`);
  const t2 = performance.now();
  const passages = idx.searchPassages('term3 term4');
  assert.ok(performance.now() - t2 < 200);
  assert.equal(passages.length, 8);
});
