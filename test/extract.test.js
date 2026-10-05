import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml, extractText, decodeEntities, lexHtml } from '../src/extract/html.js';
import { parseSitemap } from '../src/extract/sitemap.js';

const PAGE = 'https://example.com/docs/page.html';
const x = (html, opts) => extractHtml(html, PAGE, opts);

test('title, description, lang, canonical from head', () => {
  const r = x(`<!doctype html><html lang="en-GB"><head>
    <title>  Tom &amp; Jerry
      &mdash; Home </title>
    <meta name="description" content="A &quot;test&quot; page">
    <link rel="canonical" href="/canon?utm_source=x">
  </head><body><p>Hi</p></body></html>`);
  assert.equal(r.title, 'Tom & Jerry \u{2014} Home');
  assert.equal(r.description, 'A "test" page');
  assert.equal(r.lang, 'en-GB');
  assert.equal(r.canonical, 'https://example.com/canon');
  assert.equal(r.text, 'Hi');
  assert.equal(r.wordCount, 1);
});

test('title falls back to og:title then first h1', () => {
  assert.equal(x('<meta property="og:title" content="OG Title"><h1>H</h1>').title, 'OG Title');
  assert.equal(x('<body><h1>Heading <b>One</b></h1><p>x</p>').title, 'Heading One');
});

test('script/style/noscript/template/svg/iframe content is skipped, including "</div>" strings', () => {
  const r = x(`<body>
    <script>var s = "</div><p>nope</p>"; if (a < b && c > d) {}</script>
    <style>p::after { content: "</p>styled" }</style>
    <noscript><p>enable js</p></noscript>
    <template><p>tpl</p></template>
    <svg viewBox="0 0 1 1"><title>svgtitle</title><text>svgtext</text><path d="M0"/></svg>
    <iframe src="/x"><p>frame</p></iframe>
    <p>visible</p>
    <SCRIPT type="text/javascript">document.write('<p>written</p>')</SCRIPT>
    <p>after</p></body>`);
  assert.equal(r.text, 'visible\n\nafter');
  assert.doesNotMatch(r.markdown, /nope|styled|enable|tpl|svg|frame|written/);
  assert.equal(r.title, '');
});

test('comments, CDATA, doctype and processing instructions', () => {
  const r = x('<?xml version="1.0"?><!DOCTYPE html><p>a<!-- <p>hidden</p> -->b</p><!----><p><![CDATA[x < y]]></p><!-- unterminated');
  assert.equal(r.text, 'ab\n\nx < y');
});

test('uppercase tags, unquoted and boolean attributes', () => {
  const r = x('<BODY><DIV CLASS=main><A HREF=/abs/path?q=1&amp;r=2 REL=NOFOLLOW>Go</A><INPUT TYPE=checkbox CHECKED DISABLED><P>Para</P></DIV></BODY>');
  assert.deepEqual(r.links, [{ url: 'https://example.com/abs/path?q=1&r=2', text: 'Go', rel: 'nofollow', nofollow: true }]);
  assert.equal(r.text, 'Go\n\nPara');
  const toks = lexHtml('<input type=checkbox checked disabled data-x=\'1\' data-y="2">');
  assert.deepEqual({ ...toks[0].attrs }, { type: 'checkbox', checked: '', disabled: '', 'data-x': '1', 'data-y': '2' });
});

test('unclosed tags still produce sensible blocks', () => {
  const r = x('<p>one<p>two <b>bold<p>three<ul><li>a<li>b</ul><div>tail');
  assert.equal(r.text, 'one\n\ntwo bold\n\nthree\n\na\nb\n\ntail');
  assert.match(r.markdown, /^one\n\ntwo \*\*bold\*\*\n\nthree\n\n- a\n- b\n\ntail$/);
});

test('stray "<" and unterminated attribute quotes are tolerated', () => {
  assert.equal(x('<p>1 < 2 and 3 <> 4</p>').text, '1 < 2 and 3 <> 4');
  const r = x('<p>before</p><a href="/x>broken</a><p>after</p>');
  assert.match(r.text, /before/);
  assert.match(r.text, /after/);
});

test('entity decoding: named, numeric decimal/hex, legacy, cp1252, invalid', () => {
  const r = x('<p>&amp; &lt; &gt; &quot; &#39; &#x27; &nbsp;|&mdash; &ndash; &hellip; &copy; &reg; &trade; &rsquo;&lsquo;&ldquo;&rdquo; &euro; &eacute; &frac12; &deg; &times; &bull; &rarr; &#8212; &#x2014; &#146; &#0; &unknown; &copy2024 &amp</p>');
  assert.equal(
    r.text,
    "& < > \" ' ' |\u{2014} \u{2013} \u{2026} \u{a9} \u{ae} \u{2122} \u{2019}\u{2018}\u{201c}\u{201d} \u{20ac} \u{e9} \u{bd} \u{b0} \u{d7} \u{2022} \u{2192} \u{2014} \u{2014} \u{2019} \u{fffd} &unknown; \u{a9}2024 &",
  );
  assert.equal(decodeEntities('&laquo;x&raquo; &para; &sect; &middot; &iexcl; &iquest; &shy;'), '\u{ab}x\u{bb} \u{b6} \u{a7} \u{b7} \u{a1} \u{bf} \u{ad}');
  // attribute mode keeps query strings intact
  assert.equal(decodeEntities('?a=1&copy=2&amp;b=3&lang=en', { attribute: true }), '?a=1&copy=2&b=3&lang=en');
  const link = x('<a href="/s?x=1&copy=2&amp;y=3">s</a>').links[0];
  assert.equal(link.url, 'https://example.com/s?x=1&copy=2&y=3');
});

test('whitespace normalization and nbsp', () => {
  const r = x('<p>  lots   of\n\n\t whitespace&nbsp;&nbsp;here  </p>\n\n\n<p>\n next \n</p>');
  assert.equal(r.text, 'lots of whitespace here\n\nnext');
});

test('block elements produce paragraph breaks; inline elements do not', () => {
  const r = x('<div>A<span>B</span><em>C</em></div><section>D</section><article><header>E</header>F</article>line<br>break');
  assert.equal(r.text, 'ABC\n\nD\n\nE\n\nF\n\nline\nbreak');
});

test('markdown: headings, paragraphs, lists, links, code, bold, pre, blockquote', () => {
  const r = x(`<h1>Title</h1><h2>Section <a href="#frag">link</a></h2><h3>Sub</h3>
    <p>Text with <strong>strong</strong>, <b> spaced bold </b>, <code>a_b()</code>, <em>em</em> and <a href="other.html">a link</a>.</p>
    <ul><li>alpha</li><li>beta<ul><li>nested</li></ul></li></ul>
    <ol start="3"><li>third</li><li>fourth</li></ol>
    <pre>  line 1
    line 2 &lt;b&gt;</pre>
    <blockquote><p>quoted</p></blockquote>
    <p>Stars * and [brackets]</p>`);
  const md = r.markdown;
  assert.match(md, /^# Title\n\n## Section \[link\]\(https:\/\/example\.com\/docs\/page\.html\)\n\n### Sub\n\n/);
  assert.match(md, /Text with \*\*strong\*\*, \*\*spaced bold\*\* , `a_b\(\)`, \*em\* and \[a link\]\(https:\/\/example\.com\/docs\/other\.html\)\./);
  assert.match(md, /\n- alpha\n- beta\n {2}- nested\n\n3\. third\n4\. fourth\n/);
  assert.match(md, /```\n {2}line 1\n {4}line 2 <b>\n```/);
  assert.match(md, /> quoted/);
  assert.match(md, /Stars \\\* and \\\[brackets\\\]/);
  assert.deepEqual(r.headings, [
    { level: 1, text: 'Title' },
    { level: 2, text: 'Section link' },
    { level: 3, text: 'Sub' },
  ]);
  assert.match(r.text, /Text with strong, spaced bold , a_b\(\), em and a link\./);
});

test('links: base href, normalization, dropped schemes, rel=nofollow, dedupe', () => {
  const r = x(`<head><base href="https://cdn.example.org/root/"></head><body>
    <a href="a.html#frag">A</a>
    <a href="/b?utm_source=news&id=1">B</a>
    <a href="mailto:x@example.com">mail</a>
    <a href="javascript:alert(1)">js</a>
    <a href="tel:+123">tel</a>
    <a href="data:text/html,hi">data</a>
    <a href="https://other.net/" rel="nofollow ugc">ext</a>
    <a href="https://other.net/">ext again</a>
    <a href="a.html"><img src="i.png" alt="Logo"></a>
    <a name="anchor">no href</a>
  </body>`);
  assert.deepEqual(
    r.links.map((l) => [l.url, l.text, l.nofollow]),
    [
      ['https://cdn.example.org/root/a.html', 'A', false],
      ['https://cdn.example.org/b?id=1', 'B', false],
      ['https://other.net/', 'ext', false],
    ],
  );
  assert.match(r.text, /mail js tel data/);
  const nf = x('<a href="/n" rel="nofollow">n</a>').links[0];
  assert.equal(nf.nofollow, true);
  assert.equal(nf.rel, 'nofollow');
  // image-only link uses alt text
  const img = x('<a href="/home"><img src="logo.png" alt="Northwind Trails"></a>');
  assert.equal(img.links[0].text, 'Northwind Trails');
  assert.equal(img.markdown, '[Northwind Trails](https://example.com/home)');
});

test('block content inside a link keeps the link for each block', () => {
  const r = x('<a href="/card"><div>Card title</div><p>Card desc</p></a><p>outside</p>');
  assert.equal(r.markdown, '[Card title](https://example.com/card)\n\n[Card desc](https://example.com/card)\n\noutside');
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].text, 'Card title');
});

test('relative links without a base URL are dropped', () => {
  const r = extractHtml('<a href="/rel">r</a><a href="https://abs.example/">a</a>');
  assert.deepEqual(r.links.map((l) => l.url), ['https://abs.example/']);
});

test('metaRobots: robots meta, none, bot-specific tokens, case-insensitive', () => {
  assert.deepEqual(x('<meta name="robots" content="noindex, nofollow">').metaRobots, {
    noindex: true,
    nofollow: true,
    noarchive: false,
    nosnippet: false,
  });
  assert.deepEqual(x('<META NAME="ROBOTS" CONTENT="NONE">').metaRobots, {
    noindex: true,
    nofollow: true,
    noarchive: false,
    nosnippet: false,
  });
  assert.deepEqual(x('<meta name="robots" content="noarchive,nosnippet">').metaRobots, {
    noindex: false,
    nofollow: false,
    noarchive: true,
    nosnippet: true,
  });
  assert.equal(x('<meta name="robots" content="max-snippet: 0">').metaRobots.nosnippet, true);
  // Bot-scoped meta only applies when that token is requested.
  const html = '<meta name="CairnSearch" content="noindex"><meta name="OtherBot" content="nofollow">';
  assert.equal(x(html).metaRobots.noindex, false);
  assert.equal(x(html, { botTokens: ['CairnSearch', 'Cairn'] }).metaRobots.noindex, true);
  assert.equal(x(html, { botTokens: ['cairnsearch'] }).metaRobots.noindex, true);
  assert.equal(x(html, { botTokens: ['CairnCorpus', 'Cairn'] }).metaRobots.noindex, false);
  assert.equal(x(html, { botTokens: ['CairnSearch'] }).metaRobots.nofollow, false);
  assert.equal(x('<meta name="cairn" content="nosnippet">', { botTokens: ['CairnSearch', 'Cairn'] }).metaRobots.nosnippet, true);
});

test('head text is ignored; missing <body> is handled', () => {
  const r = x('<html><head><title>T</title><meta charset=utf-8>\n</head>Body text<p>more');
  assert.equal(r.title, 'T');
  assert.equal(r.text, 'Body text\n\nmore');
  const noHead = x('<title>T2</title><h1>Hello</h1>');
  assert.equal(noHead.text, 'Hello');
});

test('hidden elements, selects and tables', () => {
  const r = x('<p hidden>secret</p><div hidden><div>nested</div></div><select><option>opt</option></select><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>end</p>');
  assert.equal(r.text, 'A B\n\n1 2\n\nend');
  assert.match(r.markdown, /A \| B\n\n1 \| 2/);
});

test('non-string / empty input does not throw', () => {
  for (const input of [null, undefined, '', 42, '<', '<a', '<p', '</', '<!--', '&', '<a href="']) {
    const r = extractHtml(input, PAGE);
    assert.equal(typeof r.text, 'string');
    assert.ok(Array.isArray(r.links));
  }
});

test('large pages extract quickly', () => {
  const html = `<html><body>${'<div><p>Lorem ipsum <a href="/x">dolor</a> sit &amp; amet.</p><script>var a="</div>";</script></div>'.repeat(20000)}</body></html>`;
  const t0 = performance.now();
  const r = x(html);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(r.links.length, 1);
  assert.equal(r.wordCount, 20000 * 6);
});

test('extractText: plain text and html dispatch', () => {
  const r = extractText('\u{feff}First line title\r\nsecond   line\r\n\r\n\r\nPara two', 'text/plain; charset=utf-8');
  assert.equal(r.title, 'First line title');
  assert.equal(r.text, 'First line title\nsecond line\n\nPara two');
  assert.equal(r.markdown, r.text);
  assert.equal(r.wordCount, 7);
  assert.deepEqual(r.links, []);
  assert.equal(r.canonical, null);
  assert.deepEqual(r.metaRobots, { noindex: false, nofollow: false, noarchive: false, nosnippet: false });
  const h = extractText('<title>H</title><p>x</p>', 'text/html', { baseUrl: PAGE });
  assert.equal(h.title, 'H');
  assert.equal(extractText('', 'text/plain').title, '');
});

// ---------------------------------------------------------------------------
// Sitemaps

test('sitemap: urlset with lastmod, entities, CDATA, comments, image extension', () => {
  const r = parseSitemap(`\u{feff}<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
    <url><loc>https://ex.com/a?x=1&amp;y=2</loc><lastmod>2024-01-02</lastmod>
      <image:image><image:loc>https://ex.com/img.png</image:loc></image:image></url>
    <url>
      <loc><![CDATA[https://ex.com/b?p=1&q=2]]></loc>
    </url>
    <!-- <url><loc>https://ex.com/commented</loc></url> -->
    <url><loc> https://ex.com/c </loc></url>
    <url><loc>not a url</loc></url>
    <url><loc>https://ex.com/a?x=1&amp;y=2</loc></url>
    <url><loc>https://ex.com/unclosed</loc>
  </urlset>`);
  assert.equal(r.type, 'urlset');
  assert.deepEqual(r.urls, [
    { loc: 'https://ex.com/a?x=1&y=2', lastmod: '2024-01-02' },
    { loc: 'https://ex.com/b?p=1&q=2', lastmod: null },
    { loc: 'https://ex.com/c', lastmod: null },
    { loc: 'https://ex.com/unclosed', lastmod: null },
  ]);
  assert.deepEqual(r.sitemaps, []);
});

test('sitemap: sitemapindex', () => {
  const r = parseSitemap(`<?xml version="1.0"?>
  <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://ex.com/sitemap-pages.xml</loc><lastmod>2024-01-01</lastmod></sitemap>
    <sitemap><loc><![CDATA[https://ex.com/sitemap-blog.xml]]></loc></sitemap>
  </sitemapindex>`);
  assert.equal(r.type, 'sitemapindex');
  assert.deepEqual(r.sitemaps, ['https://ex.com/sitemap-pages.xml', 'https://ex.com/sitemap-blog.xml']);
  assert.deepEqual(r.urls, []);
});

test('sitemap: namespace-prefixed urlset', () => {
  const r = parseSitemap('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://ex.com/p</sm:loc></sm:url></sm:urlset>');
  assert.equal(r.type, 'urlset');
  assert.deepEqual(r.urls.map((u) => u.loc), ['https://ex.com/p']);
});

test('sitemap: plain text', () => {
  const r = parseSitemap('https://ex.com/one\r\n\n  https://ex.com/two  \n# comment\nftp://ex.com/nope\nhttps://ex.com/one\n');
  assert.equal(r.type, 'text');
  assert.deepEqual(r.urls, [
    { loc: 'https://ex.com/one', lastmod: null },
    { loc: 'https://ex.com/two', lastmod: null },
  ]);
  assert.deepEqual(parseSitemap(''), { type: 'text', urls: [], sitemaps: [] });
});

test('sitemap: RSS and Atom feeds are accepted as url lists', () => {
  const rss = parseSitemap('<rss version="2.0"><channel><link>https://ex.com/</link><item><title>t</title><link>https://ex.com/post-1</link></item><item><link><![CDATA[https://ex.com/post-2]]></link></item></channel></rss>');
  assert.equal(rss.type, 'urlset');
  assert.deepEqual(rss.urls.map((u) => u.loc), ['https://ex.com/post-1', 'https://ex.com/post-2']);
  const atom = parseSitemap('<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://ex.com/e1"/><updated>2024-05-01</updated></entry><entry><link href="https://ex.com/e2?a=1&amp;b=2"/></entry></feed>');
  assert.deepEqual(atom.urls, [
    { loc: 'https://ex.com/e1', lastmod: '2024-05-01' },
    { loc: 'https://ex.com/e2?a=1&b=2', lastmod: null },
  ]);
});

test('sitemap: garbage input yields an empty result', () => {
  assert.deepEqual(parseSitemap('<html><body>Not found</body></html>'), { type: 'urlset', urls: [], sitemaps: [] });
  assert.deepEqual(parseSitemap(null), { type: 'text', urls: [], sitemaps: [] });
});

test('hostile deep nesting stays linear (no event-loop stall)', () => {
  const n = 100000;
  const cases = [
    '<div>'.repeat(n) + '<li>a'.repeat(n),
    '<b>'.repeat(n) + '<p>a'.repeat(n),
    '<dl>'.repeat(n) + '<dt>a<dd>b'.repeat(n),
    '<svg>' + '<g>'.repeat(n) + '</x>'.repeat(n) + '</svg><p>t',
  ];
  const started = Date.now();
  for (const html of cases) extractHtml(html, 'http://example.com/');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('nested duplicate formatting and deep lists still render sensibly', () => {
  const ex = extractHtml('<p><b>a <b>b</b> c</b> d</p><ul><li>one<ul><li>two</li></ul></li></ul>', 'http://example.com/');
  assert.match(ex.markdown, /\*\*a b c\*\* d/);
  assert.match(ex.markdown, /- one\n  - two/);
});
