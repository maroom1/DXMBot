// Sitemap parsing (sitemaps.org protocol): XML <urlset> / <sitemapindex>,
// plain-text sitemaps (one URL per line), and RSS/Atom feeds (treated as urlsets).
// Regex-based on purpose: sitemaps are flat and frequently slightly malformed.
import { decodeEntities } from './html.js';
import { isHttpUrl } from '../util/url.js';

export const MAX_SITEMAP_URLS = 50000; // protocol limit per file

const CDATA_RE = /<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Text content of an XML element body: CDATA kept verbatim, entities decoded, tags dropped.
function textContent(raw) {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(CDATA_RE)) {
    out += decodeXml(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return (out + decodeXml(raw.slice(last))).trim();
}

function decodeXml(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ''), { attribute: true });
}

// Drop comments, but never inside CDATA sections.
function stripComments(src) {
  return src.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?(?:-->|$)/g, (m) => (m.startsWith('<!--') ? '' : m));
}

function rootElement(src) {
  const m = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?=[\s/>])/.exec(src);
  return m ? { prefix: m[1] || '', local: m[2].toLowerCase() } : null;
}

// Split the document at each `<prefix:tag` opening; tolerant of missing close tags.
function elementBodies(src, prefix, tag) {
  const re = new RegExp(`<${escapeRe(prefix)}${tag}(?=[\\s/>])`, 'gi');
  const starts = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push(m.index);
  return starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length));
}

function childText(body, prefix, tag) {
  const p = escapeRe(prefix);
  const m = new RegExp(`<${p}${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${p}${tag}\\s*>`, 'i').exec(body);
  return m ? textContent(m[1]) : null;
}

function makeCollector() {
  const seen = new Set();
  const list = [];
  return {
    list,
    add(loc, extra) {
      if (!loc || list.length >= MAX_SITEMAP_URLS) return;
      const url = loc.trim();
      if (!isHttpUrl(url) || seen.has(url)) return;
      seen.add(url);
      list.push(extra ? { loc: url, ...extra } : url);
    },
  };
}

function parseTextSitemap(src) {
  const urls = makeCollector();
  for (const line of src.split(/\r?\n/)) urls.add(line.trim(), { lastmod: null });
  return { type: 'text', urls: urls.list, sitemaps: [] };
}

export function parseSitemap(xml) {
  const src = String(xml ?? '').replace(/^\u{feff}/u, '');
  const trimmed = src.trim();
  if (!trimmed) return { type: 'text', urls: [], sitemaps: [] };
  if (!trimmed.startsWith('<')) return parseTextSitemap(trimmed);

  const doc = stripComments(src);
  const root = rootElement(doc);
  const urls = makeCollector();
  const sitemaps = makeCollector();
  const prefix = root?.prefix || '';

  if (root?.local === 'sitemapindex') {
    for (const body of elementBodies(doc, prefix, 'sitemap')) sitemaps.add(childText(body, prefix, 'loc'));
    return { type: 'sitemapindex', urls: [], sitemaps: sitemaps.list };
  }

  if (root?.local === 'rss' || root?.local === 'rdf') {
    for (const body of elementBodies(doc, '', 'item')) {
      urls.add(childText(body, '', 'link'), { lastmod: childText(body, '', 'pubDate') || null });
    }
    return { type: 'urlset', urls: urls.list, sitemaps: [] };
  }

  if (root?.local === 'feed') {
    for (const body of elementBodies(doc, prefix, 'entry')) {
      const links = [...body.matchAll(/<(?:[\w.-]+:)?link\b([^>]*)>/gi)].map((m) => m[1]);
      const alt = links.find((a) => !/\brel\s*=/.test(a) || /\brel\s*=\s*["']?alternate/i.test(a));
      const href = alt && /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(alt);
      if (href) urls.add(decodeXml(href[1] ?? href[2] ?? href[3]), { lastmod: childText(body, prefix, 'updated') || null });
    }
    return { type: 'urlset', urls: urls.list, sitemaps: [] };
  }

  // urlset (or an unknown root: salvage any <loc> elements).
  const bodies = elementBodies(doc, prefix, 'url');
  if (bodies.length) {
    for (const body of bodies) {
      urls.add(childText(body, prefix, 'loc'), { lastmod: childText(body, prefix, 'lastmod') || null });
    }
  } else {
    const p = escapeRe(prefix);
    for (const m of doc.matchAll(new RegExp(`<${p}loc(?:\\s[^>]*)?>([\\s\\S]*?)</${p}loc\\s*>`, 'gi'))) {
      urls.add(textContent(m[1]), { lastmod: null });
    }
  }
  return { type: 'urlset', urls: urls.list, sitemaps: [] };
}
