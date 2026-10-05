import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRobots,
  RobotsTxt,
  explainDecision,
  normalizeEncoding,
  matchPattern,
  MAX_ROBOTS_BYTES,
} from '../src/robots/parser.js';
import { RobotsCache, MAX_FAILURE_TTL_MS } from '../src/robots/cache.js';

const SEARCH = ['CairnSearch', 'Cairn'];
const CORPUS = ['CairnCorpus', 'Cairn'];
const USER = ['Cairn-User', 'Cairn'];

const allowed = (robots, tokens, path) => robots.isAllowed(tokens, path).allowed;

// Assert a single-rule robots.txt matches / does not match the given paths.
function expectPattern(pattern, matching, nonMatching) {
  const r = parseRobots(`User-agent: *\nDisallow: ${pattern}`);
  for (const p of matching) assert.equal(allowed(r, SEARCH, p), false, `${pattern} should match ${p}`);
  for (const p of nonMatching) assert.equal(allowed(r, SEARCH, p), true, `${pattern} should not match ${p}`);
}

describe('parser: structure', () => {
  test('parses groups with lowercased user agents, rules, crawl-delay and sitemaps', () => {
    const r = parseRobots(
      'User-agent: CairnSearch\nDisallow: /private/\nAllow: /private/ok.html\nCrawl-delay: 2\n\nSitemap: https://ex.com/sitemap.xml\n',
    );
    assert.ok(r instanceof RobotsTxt);
    assert.deepEqual(r.groups, [
      {
        userAgents: ['cairnsearch'],
        rules: [
          { type: 'disallow', path: '/private/' },
          { type: 'allow', path: '/private/ok.html' },
        ],
        crawlDelay: 2,
      },
    ]);
    assert.deepEqual(r.sitemaps, ['https://ex.com/sitemap.xml']);
  });

  test('consecutive user-agent lines share one group; user-agent after rules starts a new one', () => {
    const r = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow: /y\n');
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups[0].userAgents, ['a', 'b']);
    assert.deepEqual(r.groups[1].userAgents, ['c']);
    assert.equal(allowed(r, ['b'], '/x'), false);
    assert.equal(allowed(r, ['b'], '/y'), true);
  });

  test('rules before any user-agent are ignored', () => {
    const r = parseRobots('Disallow: /\nAllow: /x\nUser-agent: *\nDisallow: /private\n');
    assert.equal(r.groups.length, 1);
    assert.equal(allowed(r, SEARCH, '/public'), true);
    assert.equal(allowed(r, SEARCH, '/private'), false);
  });

  test('tolerates BOM, CRLF, lone CR, comments, leading whitespace, case-insensitive keys, unknown directives', () => {
    const text =
      '\u{FEFF}# comment line\r\n   USER-AGENT: CairnSearch  # trailing comment\r\n' +
      'Foo-Directive: whatever\r\n\tdIsAlLoW: /blocked # why\rALLOW:/blocked/ok\r\n' +
      'no colon here\r\nhost: example.com\r\n';
    const r = parseRobots(text);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].userAgents, ['cairnsearch']);
    assert.deepEqual(r.groups[0].rules, [
      { type: 'disallow', path: '/blocked' },
      { type: 'allow', path: '/blocked/ok' },
    ]);
    assert.equal(allowed(r, SEARCH, '/blocked/x'), false);
    assert.equal(allowed(r, SEARCH, '/blocked/ok'), true);
  });

  test('sitemaps are global, deduplicated, and do not break groups', () => {
    const r = parseRobots(
      'Sitemap: https://ex.com/a.xml\nUser-agent: x\nSitemap: https://ex.com/b.xml\nUser-agent: y\nDisallow: /z\n' +
        'SITEMAP: https://ex.com/a.xml\n',
    );
    assert.deepEqual(r.sitemaps, ['https://ex.com/a.xml', 'https://ex.com/b.xml']);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].userAgents, ['x', 'y']);
  });

  test('crawl-delay per group, invalid values ignored, resolved via selected group', () => {
    const r = parseRobots(
      'User-agent: CairnSearch\nCrawl-delay: 5\n\nUser-agent: Cairn\nCrawl-delay: 1.5\n\n' +
        'User-agent: *\nCrawl-delay: soon\nDisallow: /x\n',
    );
    assert.equal(r.crawlDelay(SEARCH), 5);
    assert.equal(r.crawlDelay(CORPUS), 1.5);
    assert.equal(r.crawlDelay(['OtherBot']), null);
    assert.equal(parseRobots('').crawlDelay(SEARCH), null);
  });

  test('limits parsing to the first 500 KiB', () => {
    const head = 'User-agent: *\nDisallow: /early\n';
    const filler = '# ' + 'x'.repeat(78) + '\n';
    let text = head;
    while (Buffer.byteLength(text) < MAX_ROBOTS_BYTES + 100) text += filler;
    text += 'Disallow: /late\n';
    const r = parseRobots(text);
    assert.equal(r.truncated, true);
    assert.equal(allowed(r, SEARCH, '/early'), false);
    assert.equal(allowed(r, SEARCH, '/late'), true, 'rules after 500 KiB are ignored');
    assert.equal(parseRobots(head).truncated, false);
  });

  test('empty or null input yields an allow-everything policy', () => {
    for (const input of ['', null, undefined, '# just a comment\n']) {
      const r = parseRobots(input);
      assert.deepEqual(r.groups, []);
      assert.deepEqual(r.isAllowed(SEARCH, '/anything'), { allowed: true, rule: null, matchedAgent: null });
    }
  });
});

describe('parser: group selection', () => {
  const text = [
    'User-agent: *',
    'Disallow: /star',
    '',
    'User-agent: Cairn',
    'Disallow: /family',
    '',
    'User-agent: cairnsearch',
    'Disallow: /search-only',
  ].join('\n');
  const r = parseRobots(text);

  test('selects the most specific token first, case-insensitively', () => {
    const g = r.selectGroup(SEARCH);
    assert.equal(g.matchedAgent, 'CairnSearch');
    assert.deepEqual(g.rules, [{ type: 'disallow', path: '/search-only' }]);
    assert.equal(allowed(r, SEARCH, '/family'), true, 'specific group replaces family group entirely');
    assert.equal(allowed(r, SEARCH, '/star'), true, 'specific group replaces * entirely');
  });

  test('falls back to the family token (CairnSearch → Cairn → *)', () => {
    const g = r.selectGroup(CORPUS);
    assert.equal(g.matchedAgent, 'Cairn');
    assert.equal(allowed(r, CORPUS, '/family'), false);
    assert.equal(allowed(r, CORPUS, '/star'), true);
  });

  test('falls back to * when no token matches', () => {
    const r2 = parseRobots('User-agent: *\nDisallow: /star\nUser-agent: OtherBot\nDisallow: /\n');
    const d = r2.isAllowed(SEARCH, '/star/x');
    assert.deepEqual(d, { allowed: false, rule: { type: 'disallow', path: '/star' }, matchedAgent: '*' });
    assert.equal(allowed(r2, SEARCH, '/other'), true);
  });

  test('no matching group and no * group → null → allow everything', () => {
    const r2 = parseRobots('User-agent: OtherBot\nDisallow: /\n');
    assert.equal(r2.selectGroup(SEARCH), null);
    assert.deepEqual(r2.isAllowed(SEARCH, '/x'), { allowed: true, rule: null, matchedAgent: null });
  });

  test('merges all groups for the same agent (and all * groups)', () => {
    const r2 = parseRobots(
      'User-agent: CairnSearch\nDisallow: /a\n\nUser-agent: other\nDisallow: /o\n\nUser-agent: cairnsearch\nDisallow: /b\nCrawl-delay: 3\n' +
        'User-agent: *\nDisallow: /s1\nUser-agent: x\nAllow: /\nUser-agent: *\nDisallow: /s2\n',
    );
    const g = r2.selectGroup(SEARCH);
    assert.deepEqual(
      g.rules.map((x) => x.path),
      ['/a', '/b'],
    );
    assert.equal(g.crawlDelay, 3);
    assert.equal(allowed(r2, SEARCH, '/a'), false);
    assert.equal(allowed(r2, SEARCH, '/b'), false);
    assert.equal(allowed(r2, SEARCH, '/o'), true);
    assert.equal(allowed(r2, ['Nobody'], '/s1'), false);
    assert.equal(allowed(r2, ['Nobody'], '/s2'), false);
  });

  test('accepts "CairnSearch/1.0" UA lines but not other tokens sharing a prefix', () => {
    const r2 = parseRobots('User-agent: CairnSearch/1.0\nDisallow: /v\n\nUser-agent: CairnSearchPlus\nDisallow: /plus\n');
    assert.equal(r2.selectGroup(SEARCH).matchedAgent, 'CairnSearch');
    assert.equal(allowed(r2, SEARCH, '/v'), false);
    assert.equal(allowed(r2, SEARCH, '/plus'), true);
    // "Cairn" (family) must not match "CairnSearch/1.0" or "CairnSearchPlus".
    assert.equal(r2.selectGroup(['Cairn']), null);
  });

  test('Cairn-User token matches its hyphenated group', () => {
    const r2 = parseRobots('User-agent: cairn-user\nDisallow: /u\n\nUser-agent: Cairn\nDisallow: /f\n');
    assert.equal(allowed(r2, USER, '/u'), false);
    assert.equal(allowed(r2, USER, '/f'), true);
    assert.equal(allowed(r2, SEARCH, '/f'), false);
  });

  test('empty Disallow is ignored but its group still takes precedence over *', () => {
    const r2 = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: CairnSearch\nDisallow:\n');
    assert.deepEqual(r2.selectGroup(SEARCH).rules, []);
    assert.deepEqual(r2.isAllowed(SEARCH, '/anything'), { allowed: true, rule: null, matchedAgent: 'CairnSearch' });
    assert.equal(allowed(r2, CORPUS, '/anything'), false);
  });

  test('RFC 9309 §5.1 example file', () => {
    const r2 = parseRobots(
      [
        'User-Agent: *',
        'Disallow: *.gif$',
        'Disallow: /example/',
        'Allow: /publications/',
        '',
        'User-Agent: foobot',
        'Disallow:/',
        'Allow:/example/page.html',
        'Allow:/example/allowed.gif',
        '',
        'User-Agent: barbot',
        'User-Agent: bazbot',
        'Disallow: /example/page.html',
        '',
        'User-Agent: quxbot',
        '',
        'EOF',
      ].join('\n'),
    );
    assert.equal(allowed(r2, ['foobot'], '/example/page.html'), true);
    assert.equal(allowed(r2, ['foobot'], '/example/allowed.gif'), true);
    assert.equal(allowed(r2, ['foobot'], '/example/other.html'), false);
    assert.equal(allowed(r2, ['foobot'], '/'), false);
    assert.equal(allowed(r2, ['barbot'], '/example/page.html'), false);
    assert.equal(allowed(r2, ['bazbot'], '/example/page.html'), false);
    assert.equal(allowed(r2, ['bazbot'], '/example/other.html'), true);
    assert.equal(allowed(r2, ['quxbot'], '/example/page.html'), true, 'group without rules allows all');
    assert.equal(allowed(r2, ['otherbot'], '/image.gif'), false);
    assert.equal(allowed(r2, ['otherbot'], '/example/x'), false);
    assert.equal(allowed(r2, ['otherbot'], '/publications/x'), true);
  });
});

describe('parser: rule matching', () => {
  test('longest match wins regardless of order', () => {
    const r = parseRobots('User-agent: *\nAllow: /private/public-note.html\nDisallow: /private/\n');
    assert.equal(allowed(r, SEARCH, '/private/secret.html'), false);
    assert.deepEqual(r.isAllowed(SEARCH, '/private/public-note.html').rule, {
      type: 'allow',
      path: '/private/public-note.html',
    });
    const r2 = parseRobots('User-agent: *\nDisallow: /a/b\nAllow: /a\n');
    assert.equal(allowed(r2, SEARCH, '/a/b/c'), false);
    assert.equal(allowed(r2, SEARCH, '/a/c'), true);
  });

  test('allow wins when matching patterns have equal length', () => {
    const r = parseRobots('User-agent: *\nDisallow: /folder\nAllow: /folder\n');
    assert.deepEqual(r.isAllowed(SEARCH, '/folder/page').rule, { type: 'allow', path: '/folder' });
    const r2 = parseRobots('User-agent: *\nAllow: /pa*\nDisallow: /pag\n');
    assert.equal(allowed(r2, SEARCH, '/page'), true);
  });

  test('Google precedence examples', () => {
    const cases = [
      ['Allow: /p\nDisallow: /', '/page', true],
      ['Allow: /folder\nDisallow: /folder', '/folder/page', true],
      ['Allow: /page\nDisallow: /*.html', '/page.html', false],
      ['Allow: /$\nDisallow: /', '/', true],
      ['Allow: /$\nDisallow: /', '/page.htm', false],
    ];
    for (const [rules, path, expected] of cases) {
      const r = parseRobots(`User-agent: *\n${rules}\n`);
      assert.equal(allowed(r, SEARCH, path), expected, `${rules.replace('\n', ' | ')} @ ${path}`);
    }
  });

  test('* wildcard matches any sequence, including empty', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*/private/*.json\n');
    assert.equal(allowed(r, SEARCH, '/a/b/private/x.json'), false);
    assert.equal(allowed(r, SEARCH, '//private/.json'), false);
    assert.equal(allowed(r, SEARCH, '/a/public/x.json'), true);
    expectPattern('/a**b', ['/ab', '/axxb', '/axxbyy'], ['/a', '/ba']);
  });

  test('$ anchors the end of the path; mid-pattern $ is literal', () => {
    expectPattern('/*.pdf$', ['/file.pdf', '/a/b.pdf'], ['/file.pdf?x=1', '/file.pdfx', '/file.PDF']);
    expectPattern('/exact$', ['/exact'], ['/exact/', '/exactly']);
    expectPattern('/a$b', ['/a$b', '/a$bc'], ['/ab']);
  });

  test('rules match against path + query', () => {
    const r = parseRobots('User-agent: *\nDisallow: /search?\nDisallow: /*?sort=\nDisallow: /*&sessionid\n');
    assert.equal(allowed(r, SEARCH, '/search?q=x'), false);
    assert.equal(allowed(r, SEARCH, '/search'), true);
    assert.equal(allowed(r, SEARCH, '/list?sort=asc'), false);
    assert.equal(allowed(r, SEARCH, '/list?page=2&sessionid=1'), false);
    assert.equal(allowed(r, SEARCH, '/list?page=2'), true);
    assert.equal(allowed(r, SEARCH, 'https://ex.com/search?q=1#frag'), false);
  });

  test('percent-encoding equivalence on both sides', () => {
    assert.equal(normalizeEncoding('/%7efoo'), '/~foo');
    assert.equal(normalizeEncoding('/%7Efoo'), '/~foo');
    assert.equal(normalizeEncoding('/a%2fb%c3%a4'), '/a%2Fb%C3%A4');
    assert.equal(normalizeEncoding('/ä b'), '/%C3%A4%20b');

    for (const pattern of ['/~foo', '/%7efoo', '/%7Efoo']) {
      const r = parseRobots(`User-agent: *\nDisallow: ${pattern}\n`);
      for (const path of ['/~foo', '/%7efoo', '/%7Efoo/bar', 'http://ex.com/%7Efoo']) {
        assert.equal(allowed(r, SEARCH, path), false, `${pattern} vs ${path}`);
      }
    }
    const hex = parseRobots('User-agent: *\nDisallow: /a%2fb\n');
    assert.equal(allowed(hex, SEARCH, '/a%2Fb'), false, 'hex case is irrelevant');
    assert.equal(allowed(hex, SEARCH, '/a/b'), true, 'reserved %2F is not the same as /');
    // RFC 9309 §2.2.2: a raw UTF-8 pattern matches the percent-encoded URL path.
    const utf8 = parseRobots('User-agent: *\nDisallow: /foo/bar/ツ\n');
    assert.equal(allowed(utf8, SEARCH, 'https://ex.com/foo/bar/ツ'), false);
    assert.equal(allowed(utf8, SEARCH, '/foo/bar/%E3%83%84'), false);
    const unres = parseRobots('User-agent: *\nDisallow: /foo/bar/%62%61%7A\n');
    assert.equal(allowed(unres, SEARCH, '/foo/bar/baz'), false);
  });

  test('/robots.txt is always allowed', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\nDisallow: /robots.txt\n');
    assert.deepEqual(r.isAllowed(SEARCH, '/robots.txt'), { allowed: true, rule: null, matchedAgent: null });
    assert.equal(allowed(r, SEARCH, 'https://ex.com/robots.txt'), true);
    assert.equal(allowed(RobotsTxt.disallowAll(), SEARCH, '/robots.txt'), true);
    assert.equal(allowed(r, SEARCH, '/robots.txt.bak'), false);
  });

  test('allowAll / disallowAll', () => {
    assert.equal(allowed(RobotsTxt.allowAll(), SEARCH, '/x'), true);
    const d = RobotsTxt.disallowAll();
    for (const p of ['/', '/x', '/a/b?c=d']) assert.equal(allowed(d, SEARCH, p), false);
    assert.equal(allowed(d, ['AnyBot'], '/'), false);
  });

  test('isAllowed accepts absolute URLs, paths and bare strings', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\n');
    assert.equal(allowed(r, SEARCH, 'https://ex.com/private/x'), false);
    assert.equal(allowed(r, SEARCH, 'https://ex.com'), true);
    assert.equal(allowed(r, SEARCH, '/private#frag'), false);
    assert.equal(allowed(r, SEARCH, 'private'), false);
    assert.equal(allowed(r, 'CairnSearch', '/private'), false, 'single token string accepted');
  });

  test('pathological wildcard patterns finish quickly', () => {
    const r = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(200)}$\n`);
    const start = Date.now();
    assert.equal(allowed(r, SEARCH, '/' + 'a'.repeat(199) + 'b'), true);
    assert.ok(Date.now() - start < 1000);
    assert.equal(matchPattern('/aaa', '/*a*a*a$'), true);
  });
});

describe('parser: Google documented examples', () => {
  test('/fish', () => {
    expectPattern(
      '/fish',
      ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything'],
      ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish'],
    );
  });

  test('/fish*', () => {
    expectPattern(
      '/fish*',
      ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything'],
      ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish'],
    );
  });

  test('/fish/', () => {
    expectPattern(
      '/fish/',
      ['/fish/', '/fish/?id=anything', '/fish/salmon.htm'],
      ['/fish', '/fish.html', '/animals/fish/', '/Fish/Salmon.asp'],
    );
  });

  test('/*.php', () => {
    expectPattern(
      '/*.php',
      ['/index.php', '/filename.php', '/folder/filename.php', '/folder/filename.php?parameters', '/folder/any.php.file.html', '/filename.php/'],
      ['/', '/windows.PHP'],
    );
  });

  test('/*.php$', () => {
    expectPattern(
      '/*.php$',
      ['/filename.php', '/folder/filename.php'],
      ['/filename.php?parameters', '/filename.php/', '/filename.php5', '/windows.PHP'],
    );
  });

  test('/fish*.php', () => {
    expectPattern('/fish*.php', ['/fish.php', '/fishheads/catfish.php?parameters'], ['/Fish.PHP', '/fish.html']);
  });
});

describe('explainDecision', () => {
  const text = 'User-agent: *\nDisallow: /private/\n\nUser-agent: CairnSearch\nAllow: /private/ok\nDisallow: /private/\nCrawl-delay: 4\n';

  test('explains a deciding rule, group and competing matches', () => {
    const s = explainDecision(text, SEARCH, 'https://ex.com/private/ok.html');
    assert.match(s, /^ALLOWED: \/private\/ok\.html for CairnSearch/);
    assert.match(s, /group for "CairnSearch"/);
    assert.match(s, /Deciding rule: "Allow: \/private\/ok"/);
    assert.match(s, /Also matched: "Disallow: \/private\/"/);
    assert.match(s, /Crawl-delay: 4 s/);
    const blocked = explainDecision(parseRobots(text), CORPUS, '/private/x');
    assert.match(blocked, /^DISALLOWED/);
    assert.match(blocked, /"\*" \(all robots\) group/);
    assert.match(blocked, /CairnCorpus → Cairn → \*/);
  });

  test('explains no-group, no-rule, /robots.txt and synthetic policies', () => {
    assert.match(explainDecision('User-agent: other\nDisallow: /\n', SEARCH, '/x'), /No group matches.*everything is allowed/);
    assert.match(explainDecision(text, SEARCH, '/public'), /No rule in that group matches/);
    assert.match(explainDecision(text, SEARCH, '/robots.txt'), /always allowed/);
    const s = explainDecision(RobotsTxt.disallowAll('robots.txt unreachable (HTTP 503)'), SEARCH, '/x');
    assert.match(s, /^DISALLOWED/);
    assert.match(s, /Note: robots.txt unreachable \(HTTP 503\)/);
  });
});

// ---------------------------------------------------------------------------

function makeFetcher(responses) {
  const calls = [];
  const fn = async (robotsUrl, role) => {
    calls.push({ robotsUrl, role });
    const r = typeof responses === 'function' ? responses(robotsUrl, calls.length) : responses[robotsUrl];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

const HOUR = 60 * 60 * 1000;

describe('RobotsCache', () => {
  test('2xx: parses body, then serves from cache until TTL expiry', async () => {
    const c = clock();
    const fetchRobots = makeFetcher(() => ({ status: 200, body: 'User-agent: *\nDisallow: /p\nSitemap: https://ex.com/s.xml' }));
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots, now: c.now });

    const a = await cache.get('https://ex.com/p/1');
    assert.equal(a.source, 'network');
    assert.equal(a.status, 200);
    assert.equal(a.origin, 'https://ex.com');
    assert.equal(a.robotsUrl, 'https://ex.com/robots.txt');
    assert.equal(a.fetchedAt, c.t);
    assert.equal(a.expiresAt, c.t + HOUR);
    assert.equal(a.robots.isAllowed(SEARCH, '/p/1').allowed, false);
    assert.deepEqual(fetchRobots.calls, [{ robotsUrl: 'https://ex.com/robots.txt', role: 'search' }]);

    c.advance(HOUR - 1);
    const b = await cache.get('https://ex.com/other', 'user');
    assert.equal(b.source, 'cache');
    assert.equal(fetchRobots.calls.length, 1, 'keyed by origin, not path or role');

    c.advance(1);
    const d = await cache.get('https://ex.com/', 'corpus');
    assert.equal(d.source, 'network');
    assert.equal(fetchRobots.calls.length, 2);
    assert.equal(fetchRobots.calls[1].role, 'corpus');
  });

  test('different ports/schemes are different origins', async () => {
    const fetchRobots = makeFetcher(() => ({ status: 404, body: null }));
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots });
    await cache.get('http://127.0.0.1:8788/a');
    await cache.get('http://127.0.0.1:8789/a');
    await cache.get('https://127.0.0.1:8788/a');
    assert.deepEqual(
      fetchRobots.calls.map((x) => x.robotsUrl),
      ['http://127.0.0.1:8788/robots.txt', 'http://127.0.0.1:8789/robots.txt', 'https://127.0.0.1:8788/robots.txt'],
    );
  });

  test('404/401/403 (and other 4xx) → allow all', async () => {
    for (const status of [404, 401, 403, 410]) {
      const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots: makeFetcher(() => ({ status, body: 'User-agent: *\nDisallow: /' })) });
      const r = await cache.get('https://ex.com/x');
      assert.equal(r.status, status);
      assert.equal(r.source, 'network');
      assert.equal(r.robots.isAllowed(SEARCH, '/x').allowed, true, `status ${status}`);
      assert.equal(r.expiresAt - r.fetchedAt, HOUR, 'unavailable is cached for the full TTL');
    }
  });

  test('5xx/429/network error without a previous copy → disallow all, cached ≤ 10 min', async () => {
    for (const status of [500, 503, 429, 0]) {
      const c = clock();
      const fetchRobots = makeFetcher(() => ({ status, body: null, error: status === 0 ? 'ECONNREFUSED' : undefined }));
      const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots, now: c.now });
      const r = await cache.get('https://ex.com/x');
      assert.equal(r.status, status);
      assert.equal(r.source, 'network');
      assert.equal(r.robots.isAllowed(SEARCH, '/x').allowed, false, `status ${status}`);
      assert.equal(r.robots.isAllowed(SEARCH, '/robots.txt').allowed, true);
      assert.equal(r.expiresAt - r.fetchedAt, MAX_FAILURE_TTL_MS);
      if (status === 0) assert.match(r.error, /ECONNREFUSED/);

      c.advance(MAX_FAILURE_TTL_MS - 1);
      assert.equal((await cache.get('https://ex.com/y')).source, 'cache');
      assert.equal(fetchRobots.calls.length, 1);
      c.advance(1);
      await cache.get('https://ex.com/y');
      assert.equal(fetchRobots.calls.length, 2, 'failure is retried after at most 10 minutes');
    }
  });

  test('failure TTL never exceeds the configured TTL', async () => {
    const cache = new RobotsCache({ ttlMs: 1000, fetchRobots: makeFetcher(() => ({ status: 503, body: null })) });
    const r = await cache.get('https://ex.com/');
    assert.equal(r.expiresAt - r.fetchedAt, 1000);
  });

  test('fetchRobots throwing is treated as a network error', async () => {
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots: makeFetcher(() => new Error('socket hang up')) });
    const r = await cache.get('https://ex.com/');
    assert.equal(r.status, 0);
    assert.equal(r.robots.isAllowed(SEARCH, '/').allowed, false);
    assert.match(r.error, /socket hang up/);
  });

  test('server errors after expiry fall back to the stale copy', async () => {
    const c = clock();
    let status = 200;
    const fetchRobots = makeFetcher(() => ({ status, body: status === 200 ? 'User-agent: *\nDisallow: /p' : null }));
    const records = [];
    const audit = { record: (e) => records.push(e) };
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots, now: c.now, audit });
    const good = await cache.get('https://ex.com/');
    c.advance(HOUR);
    status = 503;
    const stale = await cache.get('https://ex.com/');
    assert.equal(stale.source, 'stale');
    assert.equal(stale.status, 503);
    assert.equal(stale.staleFrom, good.fetchedAt);
    assert.equal(stale.robots, good.robots);
    assert.equal(stale.robots.isAllowed(SEARCH, '/p').allowed, false);
    assert.equal(stale.robots.isAllowed(SEARCH, '/q').allowed, true);
    assert.equal(stale.expiresAt - stale.fetchedAt, MAX_FAILURE_TTL_MS);
    assert.equal(records.length, 1);
    assert.match(records[0].detail, /stale/);

    // Within the failure window the stale copy is still labelled stale.
    c.advance(1000);
    assert.equal((await cache.get('https://ex.com/')).source, 'stale');
    // Repeated failures keep using the last good copy.
    c.advance(MAX_FAILURE_TTL_MS);
    status = 0;
    const again = await cache.get('https://ex.com/');
    assert.equal(again.source, 'stale');
    assert.equal(again.robots, good.robots);
    // Recovery replaces the stale copy.
    c.advance(MAX_FAILURE_TTL_MS);
    status = 200;
    assert.equal((await cache.get('https://ex.com/')).source, 'network');
    assert.equal(cache.entries()[0].stale, false);
  });

  test('concurrent get() for one origin shares a single fetch', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = [];
    const fetchRobots = async (robotsUrl, role) => {
      calls.push({ robotsUrl, role });
      await gate;
      return { status: 200, body: 'User-agent: *\nDisallow: /x' };
    };
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots });
    const ps = [cache.get('https://ex.com/a'), cache.get('https://ex.com/b', 'user'), cache.check('https://ex.com/x', 'search')];
    await new Promise((r) => setImmediate(r));
    release();
    const [a, b, chk] = await Promise.all(ps);
    assert.equal(calls.length, 1);
    assert.equal(a.robots, b.robots);
    assert.equal(chk.allowed, false);
    await cache.get('https://ex.com/c');
    assert.equal(calls.length, 1);
  });

  test('check() uses robotsTokens(role) for each role', async () => {
    const body = [
      'User-agent: *',
      'Disallow: /private/',
      '',
      'User-agent: CairnSearch',
      'Allow: /private/public-note.html',
      'Disallow: /private/',
      'Disallow: /*.pdf$',
      'Crawl-delay: 2',
      '',
      'User-agent: CairnCorpus',
      'Disallow: /',
      '',
      'User-agent: Cairn',
      'Disallow: /family-blocked/',
      '',
      'Sitemap: https://ex.com/sitemap.xml',
    ].join('\n');
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots: makeFetcher(() => ({ status: 200, body })) });

    const s = await cache.check('https://ex.com/private/public-note.html', 'search');
    assert.equal(s.allowed, true);
    assert.equal(s.matchedAgent, 'CairnSearch');
    assert.deepEqual(s.rule, { type: 'allow', path: '/private/public-note.html' });
    assert.equal(s.crawlDelay, 2);
    assert.equal(s.robotsUrl, 'https://ex.com/robots.txt');
    assert.equal(s.status, 200);
    assert.equal(s.source, 'network');
    assert.deepEqual(s.sitemaps, ['https://ex.com/sitemap.xml']);
    assert.equal((await cache.check('https://ex.com/file.pdf', 'search')).allowed, false);

    const corpus = await cache.check('https://ex.com/about.html', 'corpus');
    assert.equal(corpus.allowed, false);
    assert.equal(corpus.matchedAgent, 'CairnCorpus');
    assert.equal(corpus.source, 'cache');

    const user = await cache.check('https://ex.com/family-blocked/x', 'user');
    assert.equal(user.allowed, false);
    assert.equal(user.matchedAgent, 'Cairn');
    assert.equal(user.crawlDelay, null);
    assert.equal((await cache.check('https://ex.com/private/x', 'user')).allowed, true, 'Cairn group replaces *');

    await assert.rejects(cache.check('https://ex.com/', 'bogus'), /Unknown role/);
  });

  test('entries(), invalidate(), clear() and size', async () => {
    const c = clock();
    const fetchRobots = makeFetcher((url) =>
      url.startsWith('https://a.com') ? { status: 200, body: 'User-agent: *\nDisallow: /\nSitemap: https://a.com/s.xml' } : { status: 404, body: null },
    );
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots, now: c.now });
    await cache.get('https://a.com/x');
    await cache.get('https://b.com/y');
    assert.equal(cache.size, 2);
    const entries = cache.entries();
    assert.deepEqual(
      entries.map(({ origin, status, fetchedAt, expiresAt, groups, sitemaps }) => ({ origin, status, fetchedAt, expiresAt, groups, sitemaps })),
      [
        { origin: 'https://a.com', status: 200, fetchedAt: c.t, expiresAt: c.t + HOUR, groups: 1, sitemaps: ['https://a.com/s.xml'] },
        { origin: 'https://b.com', status: 404, fetchedAt: c.t, expiresAt: c.t + HOUR, groups: 0, sitemaps: [] },
      ],
    );

    assert.equal(cache.invalidate('https://a.com'), true);
    assert.equal(cache.invalidate('https://b.com/some/page'), true, 'accepts a URL on the origin');
    assert.equal(cache.invalidate('https://nope.com'), false);
    assert.equal(cache.size, 0);
    await cache.get('https://a.com/x');
    assert.equal(fetchRobots.calls.length, 3);

    cache.clear();
    assert.deepEqual(cache.entries(), []);
    await cache.get('https://a.com/x');
    assert.equal(fetchRobots.calls.length, 4);
  });

  test('clear() during an in-flight fetch does not repopulate the cache', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const cache = new RobotsCache({
      ttlMs: HOUR,
      fetchRobots: async () => {
        await gate;
        return { status: 200, body: '' };
      },
    });
    const p = cache.get('https://ex.com/');
    cache.clear();
    release();
    const r = await p;
    assert.equal(r.status, 200);
    assert.equal(cache.size, 0);
  });

  test('TTL is read at use time (getter), capped at 24 h, and lowering it expires old entries', async () => {
    const c = clock();
    const cfg = { ttl: 30 * 24 * HOUR };
    const fetchRobots = makeFetcher(() => ({ status: 200, body: '' }));
    const cache = new RobotsCache({ ttlMs: () => cfg.ttl, fetchRobots, now: c.now });
    const a = await cache.get('https://ex.com/');
    assert.equal(a.expiresAt, c.t + 24 * HOUR, 'capped at 24 h (RFC 9309 §2.4)');
    c.advance(10 * 1000);
    cfg.ttl = 5 * 1000;
    const b = await cache.get('https://ex.com/');
    assert.equal(b.source, 'network', 'a lowered TTL applies to the cached entry immediately');
    assert.equal(fetchRobots.calls.length, 2);
  });

  test('cache size is bounded (expired first, then least recently refreshed)', async () => {
    const c = clock();
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots: makeFetcher(() => ({ status: 200, body: '' })), now: c.now, maxEntries: 3 });
    for (let i = 0; i < 10; i++) await cache.get(`https://h${i}.example/`);
    assert.equal(cache.size, 3);
    assert.deepEqual(cache.entries().map((e) => e.origin), ['https://h7.example', 'https://h8.example', 'https://h9.example']);
  });

  test('rejects invalid URLs and missing fetchRobots', async () => {
    assert.throws(() => new RobotsCache({ ttlMs: HOUR }), /fetchRobots/);
    const cache = new RobotsCache({ ttlMs: HOUR, fetchRobots: makeFetcher(() => ({ status: 200, body: '' })) });
    await assert.rejects(cache.get('not a url'), /Invalid URL/);
  });
});

test('raw URI-unsafe characters in patterns match the percent-encoded request path', () => {
  const r = parseRobots('User-agent: *\nDisallow: /a<b\nDisallow: /q"x\nDisallow: /p{1}\nDisallow: /t`\n');
  for (const raw of ['/a<b', '/q"x', '/p{1}', '/t`k']) {
    const url = new URL(`http://example.com${raw}`).href; // WHATWG encodes these characters
    assert.equal(r.isAllowed(['Cairn'], url).allowed, false, raw);
  }
  assert.equal(r.isAllowed(['Cairn'], 'http://example.com/a%3cb').allowed, false, 'lowercase escapes too');
  assert.equal(r.isAllowed(['Cairn'], 'http://example.com/ab').allowed, true);
});
