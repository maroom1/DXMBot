// The public "who is this bot?" page for site owners (in the spirit of
// openai.com/bot): tokens, full user-agent strings, robots.txt recipes,
// published IP ranges and how to verify Web Bot Auth signatures.
import { ROLES, ROLE_IDS, FAMILY_TOKEN, VERSION, userAgent } from '../identity.js';

const JWKS_PATH = '/.well-known/http-message-signatures-directory';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ROBOTS_BEHAVIOUR = {
  search: 'Always obeys robots.txt (its own group, else <code>Cairn</code>, else <code>*</code>), <code>Crawl-delay</code>, meta robots and <code>X-Robots-Tag</code> (<code>noindex</code>, <code>nofollow</code>, <code>nosnippet</code>, <code>noarchive</code>).',
  corpus: 'Always obeys robots.txt. Blocking <code>CairnCorpus</code> opts your content out of datasets without affecting search visibility.',
  user: null, // depends on live configuration, rendered below
};

const RECIPES = [
  {
    id: 'block-all',
    title: 'Block every Cairn agent',
    body: `User-agent: CairnSearch
User-agent: CairnCorpus
User-agent: Cairn-User
User-agent: ${FAMILY_TOKEN}
Disallow: /`,
    note: `Listing each token is the most robust form. A lone <code>User-agent: ${FAMILY_TOKEN}</code> group also works, but only for agents that have no more specific group of their own.`,
  },
  {
    id: 'block-corpus',
    title: 'Opt out of dataset collection only',
    body: `User-agent: CairnCorpus
Disallow: /`,
    note: 'Search indexing and user-triggered fetches continue as before.',
  },
  {
    id: 'search-not-corpus',
    title: 'Allow search, but not the corpus collector',
    body: `User-agent: CairnSearch
Allow: /
Disallow: /account/

User-agent: CairnCorpus
Disallow: /`,
    note: 'Pages can be cited in answers; nothing is written to datasets.',
  },
  {
    id: 'block-user',
    title: 'Block user-triggered fetches',
    body: `User-agent: Cairn-User
Disallow: /`,
    note: 'Stops Ask, the Fetch inspector and the research agent from retrieving your pages on behalf of a person.',
  },
  {
    id: 'slow-down',
    title: 'Slow crawling down',
    body: `User-agent: CairnSearch
Crawl-delay: 10
Disallow: /search`,
    note: 'Crawl-delay (seconds) is honoured per host on top of Cairn’s own minimum delay.',
  },
];

function roleRow(id, config) {
  const r = ROLES[id];
  const ua = userAgent(id, config.publicBaseUrl);
  let behaviour = ROBOTS_BEHAVIOUR[id];
  if (id === 'user') {
    behaviour = config.robots?.respectForUserFetch === false
      ? '<span class="badge warn">Operator override</span> This installation is configured to fetch user-requested pages even when robots.txt disallows them. Every such fetch is still identified and audited.'
      : 'Obeys robots.txt by default (stricter than most user-triggered agents) — a disallowed page is refused and the person is told why.';
  }
  return `<tr id="role-${escapeHtml(id)}">
  <td><code class="token">${escapeHtml(r.token)}</code><div class="muted small">${escapeHtml(r.name)}</div></td>
  <td>${escapeHtml(r.purpose)}<div class="muted small">Trigger: ${escapeHtml(r.trigger)}</div></td>
  <td>${behaviour}</td>
  <td><a href="/bot/${escapeHtml(r.ipFile)}"><code>${escapeHtml(r.ipFile)}</code></a></td>
</tr>
<tr class="ua-row"><td colspan="4"><span class="muted small">Full user-agent string</span><pre class="code ua"><code>${escapeHtml(ua)}</code></pre></td></tr>`;
}

function exampleSignature(runtime) {
  try {
    const headers = runtime.signer?.signRequest({ method: 'GET', url: 'https://example.com/' }) || {};
    const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

export function renderBotPage(runtime) {
  const { config } = runtime;
  const base = config.publicBaseUrl;
  const keyId = runtime.signer?.keyId || '(signing key not initialised)';
  const signingEnabled = config.signing?.enabled !== false;
  const contact = config.contact || '';
  const contactHtml = /^[^@\s]+@[^@\s]+$/.test(contact)
    ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>`
    : escapeHtml(contact);
  const minDelay = Number(config.politeness?.minDelayMs ?? 1000);
  const perHost = Number(config.politeness?.maxConcurrencyPerHost ?? 1);
  const sig = exampleSignature(runtime);
  const v4 = config.identity?.ipv4Prefixes || [];
  const v6 = config.identity?.ipv6Prefixes || [];

  const recipes = RECIPES.map(
    (r) => `<div class="recipe" id="${r.id}"><h3>${escapeHtml(r.title)}</h3><pre class="code"><code>${escapeHtml(r.body)}</code></pre><p class="muted small">${r.note}</p></div>`,
  ).join('\n');

  const ipList = ROLE_IDS.map((id) => {
    const r = ROLES[id];
    return `<li><code>${escapeHtml(r.token)}</code> — <a href="/bot/${escapeHtml(r.ipFile)}">${escapeHtml(`${base}/bot/${r.ipFile}`)}</a></li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, nofollow">
<title>Cairn crawlers and user agents — information for site owners</title>
<link rel="stylesheet" href="/docs/assets/docs.css">
<style>
  body { font-size: 15.5px; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px 72px; }
  header.top { border-bottom: 1px solid var(--border); background: var(--panel); }
  header.top .bar { max-width: 1040px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  header.top nav a { margin-left: 18px; font-size: 14px; color: var(--muted); }
  .hero { padding: 44px 0 10px; }
  .hero h1 { font-size: 34px; line-height: 1.2; margin-bottom: 10px; }
  .token { font-weight: 600; white-space: nowrap; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  pre.ua { margin: 4px 0 2px; white-space: pre-wrap; word-break: break-all; }
  tr.ua-row td { padding-top: 0; border-bottom: 2px solid var(--border); }
  table.roles td:first-child { width: 170px; }
  table.roles td:last-child { white-space: nowrap; }
  .recipes { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .recipe { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 16px 6px; }
  .recipe h3 { margin: 14px 0 6px; font-size: 15.5px; }
  .kv { display: grid; grid-template-columns: 180px 1fr; gap: 6px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; }
  .kv dt { color: var(--muted); font-size: 13.5px; }
  .kv dd { margin: 0; word-break: break-all; }
  ol.steps li { margin-bottom: 8px; }
  @media (max-width: 700px) { .kv { grid-template-columns: 1fr; } header.top nav { display: none; } }
</style>
</head>
<body>
<header class="top"><div class="bar">
  <div class="brand"><span class="logo">▲</span> Cairn <span class="badge info">for site owners</span></div>
  <nav><a href="#agents">Agents</a><a href="#robots">robots.txt</a><a href="#ip">IP ranges</a><a href="#verify">Verify</a><a href="#contact">Contact</a><a href="/docs/">Docs</a></nav>
</div></header>
<div class="wrap">
<section class="hero">
  <h1>Cairn crawlers and user agents</h1>
  <p class="lead">Cairn is a transparent retrieval and answer engine. It identifies itself on every request, obeys robots.txt,
  paces itself per host, signs its requests with <a href="#verify">Web Bot Auth</a>, and gives you an independent control for each thing it does.</p>
  <div class="cards">
    <div class="card"><h3>One token per purpose</h3><p>Search indexing, dataset collection and user-triggered fetching each have their own robots.txt token, so you can allow one and refuse another.</p></div>
    <div class="card"><h3>Honest identity</h3><p>A stable user-agent that links to this page, a <code>From</code> header, published IP ranges and cryptographic request signatures. No browser impersonation, ever.</p></div>
    <div class="card"><h3>Polite by default</h3><p>At most ${escapeHtml(perHost)} request${perHost === 1 ? '' : 's'} in flight per host, at least ${escapeHtml(minDelay)} ms apart, <code>Crawl-delay</code> honoured, exponential backoff on 429/503 with <code>Retry-After</code>.</p></div>
  </div>
</section>

<h2 id="agents">Agents</h2>
<p>Each agent looks for its own group in robots.txt first, then the family group <code>User-agent: ${escapeHtml(FAMILY_TOKEN)}</code>, then <code>User-agent: *</code>. Settings for one agent never apply to another.</p>
<table class="roles">
  <thead><tr><th>robots.txt token</th><th>Purpose</th><th>robots.txt behaviour</th><th>IP ranges</th></tr></thead>
  <tbody>
${ROLE_IDS.map((id) => roleRow(id, config)).join('\n')}
  </tbody>
</table>
<p class="muted small">Version token: <code>/${escapeHtml(VERSION)}</code>. Every request also carries <code>From: ${escapeHtml(contact)}</code>${signingEnabled ? ' and Web Bot Auth signature headers' : ''}.</p>

<h2 id="robots">Controlling access with robots.txt</h2>
<p>Cairn follows <a href="https://www.rfc-editor.org/rfc/rfc9309">RFC 9309</a>: the most specific (longest) matching rule wins, <code>Allow</code> wins ties,
<code>*</code> and <code>$</code> wildcards are supported, and <code>Sitemap:</code> lines are used for discovery. robots.txt is cached for up to 24 hours;
if it returns 4xx everything is allowed, and if it is unreachable (5xx, 429, network error) Cairn keeps using its last good copy — or, without one,
treats the whole site as disallowed until it can read the file again.</p>
<div class="recipes">
${recipes}
</div>
<h3>Page-level controls</h3>
<table>
  <thead><tr><th>Signal</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><code>&lt;meta name="robots" content="noindex"&gt;</code></td><td>Page is fetched but not added to the search index (links may still be followed).</td></tr>
    <tr><td><code>&lt;meta name="CairnSearch" content="noindex, nofollow"&gt;</code></td><td>Same, addressed only to Cairn's search agent. Any agent token works as the meta name.</td></tr>
    <tr><td><code>X-Robots-Tag: noindex</code> / <code>X-Robots-Tag: CairnSearch: noindex</code></td><td>HTTP-header equivalent, useful for non-HTML responses.</td></tr>
    <tr><td><code>nofollow</code> (meta) / <code>rel="nofollow"</code> (link)</td><td>Links are not followed from the page, or that one link is skipped.</td></tr>
    <tr><td><code>nosnippet</code>, <code>noarchive</code></td><td>No text excerpt is shown in results or passed to the answer model beyond the title; no copy is kept for display.</td></tr>
  </tbody>
</table>

<h2 id="ip">Published IP ranges</h2>
<p>Requests from this installation originate from the ranges below, also available as JSON (same shape as other major crawler operators publish):</p>
<ul>
${ipList}
</ul>
<dl class="kv">
  <dt>IPv4 prefixes</dt><dd>${v4.length ? v4.map((p) => `<code>${escapeHtml(p)}</code>`).join(' ') : '<span class="muted">none published</span>'}</dd>
  <dt>IPv6 prefixes</dt><dd>${v6.length ? v6.map((p) => `<code>${escapeHtml(p)}</code>`).join(' ') : '<span class="muted">none published</span>'}</dd>
</dl>
<p class="muted small">A request that claims to be Cairn but arrives from outside these ranges and carries no valid signature is not from this operator.</p>

<h2 id="verify">Verifying requests (Web Bot Auth)</h2>
<p>${signingEnabled
    ? '<span class="badge good">Signing enabled</span> Every request is signed'
    : '<span class="badge warn">Signing disabled</span> This operator has currently turned signing off; when enabled, requests are signed'} with Ed25519 using
<a href="https://www.rfc-editor.org/rfc/rfc9421">HTTP Message Signatures (RFC 9421)</a> as profiled by the IETF Web Bot Auth drafts.</p>
<dl class="kv">
  <dt>Key directory</dt><dd><a href="${escapeHtml(JWKS_PATH)}">${escapeHtml(base + JWKS_PATH)}</a></dd>
  <dt>Media type</dt><dd><code>application/http-message-signatures-directory+json</code></dd>
  <dt>Key ID (JWK thumbprint)</dt><dd><code>${escapeHtml(keyId)}</code></dd>
  <dt>Algorithm</dt><dd><code>ed25519</code> (JWK <code>kty: OKP</code>, <code>crv: Ed25519</code>)</dd>
  <dt>Signed components</dt><dd><code>"@authority"</code>, <code>"signature-agent"</code>; <code>tag="web-bot-auth"</code>; validity 5 minutes</dd>
</dl>
${sig ? `<h3>Example request headers</h3><p class="muted small">Freshly generated for a request to <code>https://example.com/</code>:</p><pre class="code"><code>${escapeHtml(sig)}</code></pre>` : ''}
<h3>How to verify</h3>
<ol class="steps">
  <li>Read <code>Signature-Agent</code>. It must be the quoted origin of a Cairn operator you recognise (for this installation <code>"${escapeHtml(base)}"</code>).</li>
  <li>Fetch <code>&lt;Signature-Agent&gt;${escapeHtml(JWKS_PATH)}</code> and cache it (it is served with <code>Cache-Control: max-age=3600</code>).</li>
  <li>Parse <code>Signature-Input</code>: require <code>tag="web-bot-auth"</code>, <code>created</code> ≤ now ≤ <code>expires</code>, and a <code>keyid</code> present in the directory.</li>
  <li>Rebuild the signature base — one line per component, joined with <code>\\n</code>:
    <pre class="code"><code>"@authority": your-host.example
"signature-agent": "${escapeHtml(base)}"
"@signature-params": ("@authority" "signature-agent");created=…;expires=…;keyid="…";alg="ed25519";nonce="…";tag="web-bot-auth"</code></pre></li>
  <li>Verify the Ed25519 signature from <code>Signature: sig1=:…:</code> against that base using the JWK's <code>x</code> value. Reject on any mismatch.</li>
</ol>
<p class="muted small">Details and a reference implementation: <a href="/docs/web-bot-auth.html">Identity &amp; Web Bot Auth</a>.</p>

<h2 id="contact">Contact</h2>
<p>Questions, problems or a request to exclude your site entirely: ${contactHtml || '<span class="muted">no contact configured</span>'}.
The same address is sent in the <code>From</code> header of every request. For operator documentation see <a href="/docs/site-owners.html">For site owners</a>.</p>

<div class="footer">Cairn ${escapeHtml(VERSION)} · This page is generated live from the running configuration at ${escapeHtml(base)}/bot.</div>
</div>
</body>
</html>`;
}
