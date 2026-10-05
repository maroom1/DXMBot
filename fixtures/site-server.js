#!/usr/bin/env node
// "Northwind Trails" — a fictional outdoor-gear company website used as a
// crawl/answer fixture. It deliberately exercises every robots.txt, meta
// robots, X-Robots-Tag, redirect, rate-limit, sitemap and Web Bot Auth case
// Cairn has to handle, and records every request it receives so tests can
// prove what was (and was not) fetched.
//
//   import { startFixtureSite } from './fixtures/site-server.js';
//   node fixtures/site-server.js --port 8788
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';

function robotsTxt(base) {
  return [
    'User-agent: *',
    'Disallow: /private/',
    'Disallow: /admin/',
    '',
    'User-agent: CairnSearch',
    'Allow: /private/public-note.html',
    'Disallow: /private/',
    'Disallow: /*.pdf$',
    'Disallow: /search?',
    '',
    'User-agent: CairnCorpus',
    'Disallow: /',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HTML layout
// ---------------------------------------------------------------------------

const NAV = `<header class="site-header">
  <a class="brand" href="/">Northwind Trails</a>
  <nav aria-label="Main">
    <a href="/products/">Gear</a>
    <a href="/blog/">Trail Journal</a>
    <a href="/faq.html">Help &amp; FAQ</a>
    <a href="/about.html">About</a>
  </nav>
</header>`;

const FOOTER = `<footer class="site-footer">
  <p>&copy; 2026 Northwind Trails, Inc. &middot; 1420 West Grove Street, Boise, Idaho 83702 &middot; support@northwindtrails.example</p>
</footer>`;

const STYLE = `body{font-family:system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:0 1rem;color:#1f2a2e;line-height:1.55}
.site-header{display:flex;gap:2rem;align-items:center;border-bottom:2px solid #2f5d50;padding:1rem 0}
.site-header nav a{margin-right:1rem}.brand{font-weight:700;color:#2f5d50;text-decoration:none}
table{border-collapse:collapse}td,th{border:1px solid #c8d3cf;padding:.3rem .6rem;text-align:left}
.site-footer{border-top:1px solid #c8d3cf;margin-top:3rem;font-size:.85rem;color:#51605c}`;

function layout({ title, description, main, robots = null, canonical = null, base }) {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    robots ? `<meta name="robots" content="${robots}">` : '',
    canonical ? `<link rel="canonical" href="${base}${canonical}">` : '',
    `<style>${STYLE}</style>`,
  ].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body>
${NAV}
<main>
${main}
</main>
${FOOTER}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Page content. Each entry: { title, description, main, robots?, canonical?, headers? }
// ---------------------------------------------------------------------------

const HOME = {
  title: 'Northwind Trails — Backpacks and outerwear designed in Boise, Idaho',
  description: 'Northwind Trails designs trekking backpacks and waterproof outerwear in Boise, Idaho. Founded in 2011.',
  main: `<h1>Gear for long days on the trail</h1>
<p>Northwind Trails has designed trekking backpacks and technical outerwear in Boise, Idaho since 2011.
Everything we make is tested in the Sawtooth and Boise mountains before it reaches our shelves.</p>
<h2>Featured gear</h2>
<ul>
  <li><a href="/products/ridgeback-45.html">Ridgeback 45 backpack</a> &mdash; our best-selling 45-litre trekking pack, $189.</li>
  <li><a href="/products/summit-shell.html">Summit Shell jacket</a> &mdash; a three-layer waterproof shell, $249.</li>
</ul>
<h2>Explore</h2>
<ul>
  <li><a href="/about.html">About Northwind Trails</a></li>
  <li><a href="/products/">All products</a></li>
  <li><a href="/blog/">Trail Journal (blog)</a></li>
  <li><a href="/faq.html">Returns, warranty and shipping FAQ</a></li>
  <li><a href="/rate-limited">Today's trail conditions</a></li>
  <li><a href="/flaky">Store locations and hours</a></li>
  <li><a href="/nofollow.html">Community trail reviews</a></li>
  <li><a href="/rel-nofollow.html">Our retail partners</a></li>
  <li><a href="/noindex.html">Holiday sale preview</a></li>
  <li><a href="/xrobots.html">Spring catalog preview</a></li>
  <li><a href="/redirect">Our story</a></li>
  <li><a href="/redirect-to-private">Staff resources</a></li>
  <li><a href="/canonical-dup.html">About us (printer-friendly)</a></li>
  <li><a href="/dup-content.html">Trail Journal archive: Boise foothills hikes</a></li>
  <li><a href="/file.pdf">Ridgeback 45 spec sheet (PDF)</a></li>
  <li><a href="/data.json">Product data feed (JSON)</a></li>
  <li><a href="/search?q=x">Search the store</a></li>
</ul>`,
};

const ABOUT = {
  title: 'About Northwind Trails',
  description: 'Northwind Trails is an independent outdoor-gear company founded in 2011 and headquartered in Boise, Idaho.',
  main: `<h1>About Northwind Trails</h1>
<p>Northwind Trails is an independent outdoor-gear company headquartered in Boise, Idaho. The company was
founded in 2011 by Maya Castellanos and Tom Reyes, two former backcountry rangers who were tired of packs that
fell apart after a single season.</p>
<p>Our headquarters, design studio and repair center share one building at 1420 West Grove Street in downtown
Boise. About 85 people work there, including the six-person repair team that services every pack we have ever sold.</p>
<h2>What we believe</h2>
<ul>
  <li>Gear should last decades, which is why every Northwind Trails pack carries a lifetime warranty.</li>
  <li>Fabrics should be recycled where possible: 80 percent of our 2026 line uses recycled nylon or polyester.</li>
  <li>Customers deserve time to decide: any purchase can be returned within 60 days.</li>
</ul>
<h2>Press and staff</h2>
<p>Journalists can find our media kit in the <a href="/private/public-note.html">press note</a>.
Employees can review the <a href="/private/secret.html">internal pricing plan</a> (staff only).</p>`,
};

const PRODUCTS_INDEX = {
  title: 'All products — Northwind Trails',
  description: 'Backpacks and outerwear from Northwind Trails.',
  main: `<h1>All products</h1>
<table>
  <thead><tr><th>Product</th><th>Category</th><th>Price</th></tr></thead>
  <tbody>
    <tr><td><a href="/products/ridgeback-45.html">Ridgeback 45</a></td><td>Trekking backpack</td><td>$189</td></tr>
    <tr><td><a href="/products/summit-shell.html">Summit Shell</a></td><td>Waterproof jacket</td><td>$249</td></tr>
  </tbody>
</table>`,
};

const RIDGEBACK = {
  title: 'Ridgeback 45 Backpack — Northwind Trails',
  description: 'The Ridgeback 45 is a 45-litre trekking backpack that weighs 1.2 kg and costs $189.',
  main: `<h1>Ridgeback 45 Backpack</h1>
<p class="price">$189 USD</p>
<p>The Ridgeback 45 is our 45-litre trekking backpack for trips of two to five nights. The Ridgeback 45 weighs
1.2 kg (2.6 lb) including the lid and hip belt, which makes it one of the lightest framed packs in its class.</p>
<h2>Ridgeback 45 specifications</h2>
<table>
  <tbody>
    <tr><th>Capacity</th><td>45 litres</td></tr>
    <tr><th>Weight</th><td>1.2 kg (2.6 lb)</td></tr>
    <tr><th>Price</th><td>$189</td></tr>
    <tr><th>Fabric</th><td>210-denier recycled ripstop nylon, PFAS-free water-repellent finish</td></tr>
    <tr><th>Frame</th><td>Aluminium perimeter stay with HDPE framesheet</td></tr>
    <tr><th>Torso fit</th><td>Adjustable, 41&ndash;53 cm</td></tr>
    <tr><th>Recommended load</th><td>Up to 18 kg</td></tr>
    <tr><th>Colours</th><td>Slate, Juniper, Ember</td></tr>
    <tr><th>Warranty</th><td>Lifetime warranty</td></tr>
  </tbody>
</table>
<h2>Weight and carry</h2>
<p>At a weight of 1.2 kg the Ridgeback 45 carries loads up to 18 kg comfortably. The weight is kept low by a
single aluminium stay and a removable lid; without the lid the Ridgeback 45 weight drops to 1.05 kg.</p>
<h2>Warranty and returns</h2>
<p>Like every Northwind Trails pack, the Ridgeback 45 is covered by our lifetime warranty. If it is not right
for you, return it within 60 days for a full refund. See the <a href="/faq.html">FAQ</a> for details.</p>`,
};

const SUMMIT = {
  title: 'Summit Shell Jacket — Northwind Trails',
  description: 'The Summit Shell is a three-layer waterproof jacket rated to 20,000 mm, priced at $249.',
  main: `<h1>Summit Shell Jacket</h1>
<p class="price">$249 USD</p>
<p>The Summit Shell is a three-layer waterproof and breathable jacket for alpine hiking and ski touring. Its
membrane is rated to 20,000 mm of waterproofing (20k) and 20,000 g/m&sup2;/24h of breathability, and every seam
is fully taped.</p>
<h2>Specifications</h2>
<table>
  <tbody>
    <tr><th>Waterproof rating</th><td>20,000 mm</td></tr>
    <tr><th>Breathability</th><td>20,000 g/m&sup2;/24h</td></tr>
    <tr><th>Construction</th><td>3-layer recycled polyester face fabric</td></tr>
    <tr><th>Mass</th><td>395 g (men's medium)</td></tr>
    <tr><th>Features</th><td>Helmet-compatible hood, 30 cm pit zips, two chest pockets</td></tr>
    <tr><th>Sizes</th><td>XS&ndash;XXL</td></tr>
    <tr><th>Price</th><td>$249</td></tr>
    <tr><th>Warranty</th><td>2-year warranty on apparel</td></tr>
  </tbody>
</table>
<p>Apparel, including the Summit Shell, is covered by a two-year warranty against defects and can be returned
within 60 days.</p>`,
};

const FAQ = {
  title: 'Help & FAQ: returns, warranty and shipping — Northwind Trails',
  description: 'Northwind Trails accepts returns within 60 days and offers a lifetime warranty on packs.',
  main: `<h1>Help &amp; FAQ</h1>
<h2>What is your return policy?</h2>
<p>You can return any Northwind Trails product within 60 days of delivery for a full refund or an exchange.
Items should be clean; used gear is accepted. Return shipping is free within the United States.</p>
<h2>What warranty do you offer?</h2>
<p>All Northwind Trails packs, including the Ridgeback 45, have a lifetime warranty covering materials and
workmanship. Apparel such as the Summit Shell has a two-year warranty. Our Boise repair center fixes damage
that is not covered for a flat fee.</p>
<h2>How fast do you ship?</h2>
<p>Orders ship from our Boise, Idaho warehouse within two business days. Shipping is free on orders over $75.</p>
<h2>Where are you located?</h2>
<p>Our headquarters and flagship store are in Boise, Idaho. Northwind Trails was founded there in 2011.</p>
<h2>How do I contact support?</h2>
<p>Email support@northwindtrails.example or call +1 208 555 0142, Monday to Friday, 8 am to 5 pm Mountain Time.</p>`,
};

const BLOG_INDEX = {
  title: 'Trail Journal — Northwind Trails',
  description: 'Stories, guides and trip reports from the Northwind Trails team.',
  main: `<h1>Trail Journal</h1>
<ul>
  <li><a href="/blog/post-1.html">Five classic day hikes in the Boise foothills</a> (April 12, 2026)</li>
  <li><a href="/blog/post-2.html">Layering 101: staying dry without overheating</a> (May 3, 2026)</li>
  <li><a href="/blog/post-3.html">Packing for the Sawtooths: a five-day checklist</a> (June 21, 2026)</li>
</ul>`,
};

const POST_1 = {
  title: 'Five classic day hikes in the Boise foothills — Trail Journal',
  description: 'Five favourite day hikes within 30 minutes of downtown Boise.',
  main: `<article>
<h1>Five classic day hikes in the Boise foothills</h1>
<p><em>Posted April 12, 2026 by Maya Castellanos</em></p>
<p>One of the best things about working in Boise is how quickly you can reach the trailhead. These five hikes
are all within 30 minutes of our downtown office.</p>
<ol>
  <li><strong>Table Rock</strong> &mdash; a steep 5.6 km round trip to a mesa with views over the whole valley.</li>
  <li><strong>Hulls Gulch</strong> &mdash; a shaded creekside trail that stays cool in early summer.</li>
  <li><strong>Camel's Back Park to Kestrel</strong> &mdash; rolling singletrack, busy with runners at dawn.</li>
  <li><strong>Stack Rock</strong> &mdash; granite towers reached through pine forest above Bogus Basin Road.</li>
  <li><strong>Mores Mountain</strong> &mdash; a wildflower loop near 2,200 m, best in July.</li>
</ol>
<p>Carry at least two litres of water in summer; the foothills are dry and exposed after 11 am.</p>
<p>Continue with <a href="/blog/post-2.html">Layering 101</a>.</p>
</article>`,
};

const POST_2 = {
  title: 'Layering 101: staying dry without overheating — Trail Journal',
  description: 'How base, mid and shell layers work together.',
  main: `<article>
<h1>Layering 101: staying dry without overheating</h1>
<p><em>Posted May 3, 2026 by Tom Reyes</em></p>
<p>A good layering system has three parts: a base layer that moves sweat away from your skin, an insulating mid
layer, and a waterproof shell. The shell only needs to come out when the weather turns.</p>
<p>Waterproof ratings are measured in millimetres of water column. Our Summit Shell is rated to 20,000 mm, which
is enough for sustained mountain rain. Vent early: opening pit zips before you start sweating keeps the inside of
the jacket dry.</p>
<p>Next up: <a href="/blog/post-3.html">Packing for the Sawtooths</a>.</p>
</article>`,
};

const POST_3 = {
  title: 'Packing for the Sawtooths: a five-day checklist — Trail Journal',
  description: 'The checklist our team uses for a five-day loop in the Sawtooth Wilderness.',
  main: `<article>
<h1>Packing for the Sawtooths: a five-day checklist</h1>
<p><em>Posted June 21, 2026 by the Northwind Trails team</em></p>
<p>Every June our design team spends five days in the Sawtooth Wilderness testing prototypes. This is the list we
start from.</p>
<ul>
  <li>Shelter: a two-person tent shared between two hikers</li>
  <li>Sleep: a quilt rated to &minus;4 &deg;C and an insulated pad</li>
  <li>Kitchen: canister stove, 1 litre pot, bear-resistant food container</li>
  <li>Clothing: sun hoody, fleece, puffy, rain shell, spare socks</li>
  <li>Navigation: paper map of the Sawtooth National Recreation Area plus a GPS app</li>
</ul>
<p>Read how it went in the <a href="/blog/deep/level-3.html">trip report, part 1</a>.</p>
</article>`,
};

const LEVEL_3 = {
  title: 'Sawtooth trip report, part 1: Redfish Lake to Alpine Lake — Trail Journal',
  description: 'Days one and two of our Sawtooth Wilderness test trip.',
  main: `<article>
<h1>Sawtooth trip report, part 1: Redfish Lake to Alpine Lake</h1>
<p>We started at Redfish Lake and took the morning shuttle boat to the inlet, saving 8 km of lakeshore walking.
The climb to Alpine Lake gained 600 m and we camped there under Mount Heyburn on the first night.</p>
<p>Continue to <a href="/blog/deep/level-4.html">part 2</a>.</p>
</article>`,
};

const LEVEL_4 = {
  title: 'Sawtooth trip report, part 2: Sawtooth Lake to Iron Creek — Trail Journal',
  description: 'Days three to five of our Sawtooth Wilderness test trip.',
  main: `<article>
<h1>Sawtooth trip report, part 2: Sawtooth Lake to Iron Creek</h1>
<p>On day four we reached Sawtooth Lake, the largest lake in the range, and watched a thunderstorm roll over
Mount Regan. We finished at the Iron Creek trailhead after 62 km in total.</p>
</article>`,
};

const PUBLIC_NOTE = {
  title: 'Press note: Northwind Trails media kit',
  description: 'Media kit and press contacts for Northwind Trails.',
  main: `<h1>Press note: media kit</h1>
<p>Northwind Trails welcomes coverage from journalists and outdoor writers. Our media kit contains high-resolution
product photography, founder biographies and our 2026 sustainability report.</p>
<p>Press enquiries: press@northwindtrails.example. We aim to reply within one business day.</p>`,
};

const SECRET = {
  title: 'INTERNAL: 2027 pricing plan — Northwind Trails staff only',
  description: 'Internal document. Not for publication.',
  main: `<h1>Internal: 2027 pricing plan</h1>
<p>CONFIDENTIAL. Planned 2027 list prices are under review by the leadership team. Do not share outside the company.</p>
<p>Staff tools are in the <a href="/admin/index.html">admin console</a>.</p>`,
};

const ADMIN = {
  title: 'Admin console — Northwind Trails',
  description: 'Staff administration console.',
  main: `<h1>Admin console</h1>
<form><label>Staff email <input name="email"></label> <label>Password <input type="password" name="password"></label> <button>Sign in</button></form>`,
};

const NOINDEX = {
  title: 'Holiday sale preview (draft) — Northwind Trails',
  description: 'Draft page for the upcoming holiday sale.',
  robots: 'noindex',
  main: `<h1>Holiday sale preview</h1>
<p>This page is a draft and is not meant to appear in search results. Final discounts will be announced in November.</p>
<p>In the meantime, browse our <a href="/via-noindex.html">2026 gift guide</a>.</p>`,
};

const VIA_NOINDEX = {
  title: '2026 gift guide — Northwind Trails',
  description: 'Gift ideas for hikers from Northwind Trails.',
  main: `<h1>2026 gift guide</h1>
<p>Stuck for ideas? Our team's favourite gifts for hikers this year are a pair of merino hiking socks, a
lightweight trekking umbrella, and a Northwind Trails gift card, which never expires.</p>`,
};

const XROBOTS = {
  title: 'Spring catalog preview — Northwind Trails',
  description: 'Preview of the upcoming spring catalog.',
  headers: { 'X-Robots-Tag': 'noindex' },
  main: `<h1>Spring catalog preview</h1>
<p>An early look at our spring colours. This preview is excluded from search engines with an X-Robots-Tag header.</p>`,
};

const NOFOLLOW = {
  title: 'Community trail reviews — Northwind Trails',
  description: 'Trail reviews submitted by the Northwind Trails community.',
  robots: 'nofollow',
  main: `<h1>Community trail reviews</h1>
<p>These reviews are written by customers. We do not vouch for links posted by reviewers, so crawlers are asked
not to follow any link on this page.</p>
<blockquote>&ldquo;Loved the Stack Rock loop, full write-up on my blog.&rdquo; &mdash; <a href="/hidden-behind-nofollow.html">a reviewer's page</a></blockquote>`,
};

const HIDDEN_NOFOLLOW = {
  title: 'Reviewer page — Northwind Trails',
  description: 'Only reachable through a nofollow page.',
  main: `<h1>Reviewer page</h1>
<p>This page is only linked from a page marked nofollow. A compliant crawler never discovers it through links.</p>`,
};

const REL_NOFOLLOW = {
  title: 'Retail partners — Northwind Trails',
  description: 'Shops that stock Northwind Trails gear.',
  main: `<h1>Retail partners</h1>
<p>Northwind Trails gear is stocked by independent outdoor shops across the Mountain West, including stores in
Boise, Ketchum, Missoula and Bend.</p>
<p>Sponsored: <a href="/hidden-rel-nofollow.html" rel="nofollow">partner promotion</a>.</p>`,
};

const HIDDEN_REL_NOFOLLOW = {
  title: 'Partner promotion — Northwind Trails',
  description: 'Only reachable through a rel=nofollow link.',
  main: `<h1>Partner promotion</h1>
<p>This page is only linked with rel="nofollow". A compliant crawler never discovers it through links.</p>`,
};

const TRAIL_CONDITIONS = {
  title: "Today's trail conditions — Northwind Trails",
  description: 'Daily trail conditions around Boise, updated by our staff.',
  main: `<h1>Today's trail conditions</h1>
<p>Updated every morning by our staff. The Boise foothills trails are dry and open. Bogus Basin Road is clear to
the ski area. Snow remains above 2,400 m in the Sawtooth Wilderness, and the Alpine Lake trail has two creek
crossings running high.</p>`,
};

const STORES = {
  title: 'Store locations and hours — Northwind Trails',
  description: 'Visit the Northwind Trails flagship store in Boise, Idaho.',
  main: `<h1>Store locations and hours</h1>
<p>Our flagship store is at 1420 West Grove Street, Boise, Idaho. It is open Monday to Saturday 9 am to 7 pm and
Sunday 10 am to 5 pm. The repair counter in the same building accepts packs for warranty service during store
hours.</p>`,
};

const ORPHAN = {
  title: 'Repair & Renew program — Northwind Trails',
  description: 'Trade in worn Northwind Trails gear for store credit.',
  main: `<h1>Repair &amp; Renew program</h1>
<p>Send us any worn Northwind Trails pack or jacket and we will either repair it or give you store credit toward
new gear: $40 for packs and $30 for jackets. Renewed items are cleaned, repaired in Boise and resold at a discount.</p>`,
};

function staticPages() {
  return {
    '/': HOME,
    '/about.html': ABOUT,
    '/canonical-dup.html': { ...ABOUT, canonical: '/about.html' },
    '/products/': PRODUCTS_INDEX,
    '/products/ridgeback-45.html': RIDGEBACK,
    '/products/summit-shell.html': SUMMIT,
    '/faq.html': FAQ,
    '/blog/': BLOG_INDEX,
    '/blog/post-1.html': POST_1,
    // Same rendered page, so the extracted body text is byte-identical.
    '/dup-content.html': POST_1,
    '/blog/post-2.html': POST_2,
    '/blog/post-3.html': POST_3,
    '/blog/deep/level-3.html': LEVEL_3,
    '/blog/deep/level-4.html': LEVEL_4,
    '/private/public-note.html': PUBLIC_NOTE,
    '/private/secret.html': SECRET,
    '/admin/index.html': ADMIN,
    '/admin/': ADMIN,
    '/noindex.html': NOINDEX,
    '/via-noindex.html': VIA_NOINDEX,
    '/xrobots.html': XROBOTS,
    '/nofollow.html': NOFOLLOW,
    '/hidden-behind-nofollow.html': HIDDEN_NOFOLLOW,
    '/rel-nofollow.html': REL_NOFOLLOW,
    '/hidden-rel-nofollow.html': HIDDEN_REL_NOFOLLOW,
    '/orphan.html': ORPHAN,
  };
}

const PAGES = staticPages();

// Listed in the page sitemap. /orphan.html is linked from nowhere else.
const SITEMAP_PATHS = [
  '/',
  '/about.html',
  '/products/',
  '/products/ridgeback-45.html',
  '/products/summit-shell.html',
  '/faq.html',
  '/blog/',
  '/private/public-note.html',
  '/orphan.html',
];

function sitemapIndexXml(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-pages.xml</loc><lastmod>2026-09-01</lastmod></sitemap>
</sitemapindex>
`;
}

function sitemapPagesXml(base) {
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${base}${p}</loc><lastmod>2026-09-01</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

const PRODUCT_FEED = {
  company: 'Northwind Trails',
  headquarters: 'Boise, Idaho',
  founded: 2011,
  products: [
    { sku: 'NWT-RB45', name: 'Ridgeback 45', category: 'backpack', priceUsd: 189, capacityLitres: 45, weightKg: 1.2, warranty: 'lifetime' },
    { sku: 'NWT-SS01', name: 'Summit Shell', category: 'jacket', priceUsd: 249, waterproofMm: 20000, weightGrams: 395, warranty: '2 years' },
  ],
  returnWindowDays: 60,
};

// A minimal, valid one-page PDF.
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

function searchPage(query) {
  const q = query.trim().toLowerCase();
  const hits = Object.entries(PAGES).filter(
    ([p, page]) => q && !p.startsWith('/private/') && !p.startsWith('/admin/') && `${page.title} ${page.description}`.toLowerCase().includes(q),
  );
  const items = hits.map(([p, page]) => `<li><a href="${p}">${page.title}</a></li>`).join('\n');
  return {
    title: 'Search results — Northwind Trails',
    description: 'Store search results.',
    robots: 'noindex',
    main: `<h1>Search results</h1>\n<p>${hits.length} result(s).</p>\n<ul>\n${items}\n</ul>`,
  };
}

// ---------------------------------------------------------------------------
// Web Bot Auth verification for /signed-only
// ---------------------------------------------------------------------------

// Signature-Agent is a structured-field string: "https://agent.example". Newer
// drafts use a dictionary member (sig1="..."), so accept both.
function parseSignatureAgent(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(?:[a-z][a-z0-9_.*-]*=)?"([^"]+)"$/i);
  const raw = m ? m[1] : String(value).trim();
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

async function verifySignedRequest(req, base) {
  const agent = parseSignatureAgent(req.headers['signature-agent']);
  if (!agent) return { verified: false, reason: 'missing or invalid Signature-Agent header' };
  if (!req.headers['signature'] || !req.headers['signature-input']) return { verified: false, reason: 'missing Signature / Signature-Input headers', agent };

  let jwks;
  try {
    const res = await globalThis.fetch(agent + DIRECTORY_PATH, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/http-message-signatures-directory+json, application/json' } });
    if (!res.ok) return { verified: false, reason: `key directory returned HTTP ${res.status}`, agent };
    jwks = await res.json();
  } catch (e) {
    return { verified: false, reason: `could not fetch key directory: ${e.message}`, agent };
  }

  // Imported lazily so the fixture stays usable even while the signing module is unavailable.
  const { verifyRequest } = await import('../src/net/signing.js');
  const result = verifyRequest({ method: req.method, url: base + req.url, headers: req.headers }, jwks);
  if (!result.valid) return { verified: false, reason: result.reason || 'signature did not verify', agent };
  return { verified: true, keyid: result.keyid, agent };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startFixtureSite({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  const pendingTimers = new Set();
  // One-shot failure states, armed once per server lifetime.
  const hits = { rateLimited: 0, flaky: 0 };
  let boundBase = null;

  const baseFor = (req) => {
    const h = req.headers.host;
    return h && /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(h) ? `http://${h}` : boundBase;
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, { 'Content-Length': buf.length, 'Cache-Control': 'no-cache', ...headers });
    res.end(buf);
  };
  const sendHtml = (res, status, page, base) =>
    send(res, status, layout({ ...page, base }), { 'Content-Type': 'text/html; charset=utf-8', ...(page.headers || {}) });
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });

  async function handle(req, res) {
    requests.push({ ts: Date.now(), method: req.method, path: req.url, headers: { ...req.headers } });
    const base = baseFor(req);
    const url = new URL(req.url, base);
    const p = url.pathname;

    switch (p) {
      case '/robots.txt':
        return send(res, 200, robotsTxt(base), { 'Content-Type': 'text/plain; charset=utf-8' });
      case '/sitemap.xml':
        return send(res, 200, sitemapIndexXml(base), { 'Content-Type': 'application/xml; charset=utf-8' });
      case '/sitemap-pages.xml':
        return send(res, 200, sitemapPagesXml(base), { 'Content-Type': 'application/xml; charset=utf-8' });
      case '/redirect':
        return send(res, 301, '', { Location: '/about.html' });
      case '/redirect-to-private':
        return send(res, 302, '', { Location: '/private/secret.html' });
      case '/rate-limited':
        if (hits.rateLimited++ === 0) {
          return send(res, 429, 'Too many requests. Please retry after 1 second.\n', { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' });
        }
        return sendHtml(res, 200, TRAIL_CONDITIONS, base);
      case '/flaky':
        if (hits.flaky++ === 0) {
          return send(res, 503, 'Service temporarily unavailable.\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        return sendHtml(res, 200, STORES, base);
      case '/file.pdf':
        return send(res, 200, PDF_BYTES, { 'Content-Type': 'application/pdf' });
      case '/data.json':
        return sendJson(res, 200, PRODUCT_FEED);
      case '/search':
        return sendHtml(res, 200, searchPage(url.searchParams.get('q') || ''), base);
      case '/echo-headers':
        return sendJson(res, 200, { method: req.method, path: req.url, headers: req.headers });
      case '/slow': {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          if (!res.destroyed) send(res, 200, 'Thanks for waiting.\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        }, 3000);
        pendingTimers.add(timer);
        return undefined;
      }
      case '/signed-only': {
        const result = await verifySignedRequest(req, base);
        return sendJson(res, result.verified ? 200 : 401, result);
      }
      default: {
        const page = PAGES[p];
        if (page) return sendHtml(res, 200, page, base);
        return sendHtml(res, 404, { title: 'Page not found — Northwind Trails', description: 'Not found.', main: '<h1>Page not found</h1><p>Try the <a href="/">home page</a>.</p>' }, base);
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 500, `Internal error: ${e.message}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const hostPart = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  boundBase = `http://${hostPart}:${addr.port}`;

  return {
    url: boundBase,
    port: addr.port,
    server,
    requests,
    // Clears the request log in place (existing references stay valid). Pass
    // {rearm:true} to also re-arm the one-shot 429 (/rate-limited) and 503 (/flaky).
    reset({ rearm = false } = {}) {
      requests.length = 0;
      if (rearm) {
        hits.rateLimited = 0;
        hits.flaky = 0;
      }
    },
    close() {
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function parseArgs(argv) {
  const opts = { port: 8788, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--port' || flag === '-p') opts.port = Number(value());
    else if (flag === '--host') opts.host = value();
    else if (flag === '--help' || flag === '-h') opts.help = true;
  }
  return opts;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    process.stdout.write(`Usage: node ${fileURLToPath(import.meta.url)} [--port 8788] [--host 127.0.0.1]\n`);
    process.exit(opts.help ? 0 : 2);
  }
  const site = await startFixtureSite(opts);
  process.stdout.write(`Northwind Trails fixture site listening at ${site.url}\n`);
  process.stdout.write(`  robots.txt: ${site.url}/robots.txt   sitemap: ${site.url}/sitemap.xml\n`);
  const shutdown = async () => {
    await site.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
