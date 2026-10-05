# Cairn — Build Contract (SPEC)

Cairn is a local, **transparent, robots.txt-respecting web retrieval + answer engine**, modelled on the
OpenAI bot family (OAI-SearchBot / GPTBot / ChatGPT-User, docs at developers.openai.com/api/docs/bots) and
xAI's xAI-Bot/GrokBot (training crawl, DeepSearch retrieval fetch, user-triggered fetch). It crawls & indexes
sites, answers questions with citations (Claude CLI), and runs a Claude-driven "deep research" agent that
uses Cairn's own compliant fetcher through an MCP server.

**Hard rules (all agents):**
- Node.js >= 20, ES modules (`"type":"module"`), **zero npm runtime dependencies** (only `node:*` built-ins).
- Tests use the built-in runner: `node:test` + `node:assert/strict`. Test files: `test/<area>.test.js`.
- Never spoof a browser UA, never rotate IPs, never evade bot detection. Cairn is honest about who it is.
- All servers bind `127.0.0.1` by default. Use absolute imports relative to file (e.g. `'../util/url.js'`).
- Read `config.*` values at use time (the server rewrites `config.publicBaseUrl` after binding a port).
- Only edit the files you own (listed per module). If you need something from another module, code
  against the interface below; do not modify their files.
- Existing foundation files (DO NOT rewrite; you may read): `package.json`, `src/config.js`,
  `src/identity.js`, `src/util/url.js`, `src/util/audit.js`, `src/runtime.js`, `docs/assets/docs.css`,
  `docs/assets/mermaid.min.js`.

## Identity (src/identity.js — exists)
| role id | robots token | purpose | notes |
|---|---|---|---|
| `search` | `CairnSearch` | search index crawl | like OAI-SearchBot |
| `corpus` | `CairnCorpus` | dataset/training collection → `data/corpus/<jobId>.jsonl` | like GPTBot; opt-out independent of search |
| `user` | `Cairn-User` | user-triggered fetch (Ask / Fetch inspector / research agent) | like ChatGPT-User, but **respects robots by default** (`config.robots.respectForUserFetch`) |

Family token `Cairn` is a fallback group. `robotsTokens(role)` → `[roleToken, 'Cairn']`.
UA: `userAgent(role, config.publicBaseUrl)` → `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; CairnSearch/1.0; +http://127.0.0.1:8787/bot`

## Foundation APIs (exist)
- `src/config.js`: `loadConfig(overrides)`, `saveConfig(config, partial)`, `defaultConfig()`, `PROJECT_ROOT`, `EDITABLE_KEYS`, `deepMerge`.
  Config shape: `{host, port, publicBaseUrl, publicBaseUrlExplicit, contact, dataDir, identity:{ipv4Prefixes,ipv6Prefixes}, fetch:{timeoutMs,maxBytes,maxRedirects,retries,blockPrivateNetworks}, politeness:{minDelayMs,maxConcurrencyPerHost,globalConcurrency,backoffBaseMs,maxBackoffMs}, robots:{cacheTtlMs,respectForUserFetch}, crawl:{maxPages,maxDepth,sameSiteOnly,useSitemaps,concurrency}, agent:{claudeBin,model,timeoutMs,maxBudgetUsd,maxPassages}, signing:{enabled}}`
- `src/util/url.js`: `normalizeUrl(input, base?) → string|null`, `isHttpUrl`, `originOf`, `hostOf` (host:port), `siteOf` (hostname minus www.), `sameSite(a,b)`, `pathWithQuery(url)`, `robotsUrlFor(url)`, `isPrivateHost(hostname)`.
- `src/util/audit.js`: `new AuditLog({file, maxMemory})`; `.record(entry) → entry(with id, ts)`; `.recent({limit, role, host, kind, sinceId})` newest-first; `.stats()`; `.subscribe(fn) → unsubscribe`; `.close()`; emits `'entry'`.
  Fetch entry fields: `{kind:'fetch'|'robots', role, token, method:'GET', url, finalUrl, status, bytes, elapsedMs, robots:'allowed'|'disallowed'|'skipped', rule, blocked:null|reason, signed:boolean, attempt, error:null|string}`.
  Other kinds: `'crawl'` `{jobId, event, url?, detail?}`, `'agent'` `{mode, model, costUsd, durationMs, ok}`.
- `src/runtime.js`: `createRuntime(overrides) → {config, audit, signer, scheduler, fetcher, robots, index, jobs, startedAt, close()}`.

---

## Module: robots (owner: robots agent)
Files: `src/robots/parser.js`, `src/robots/cache.js`, `test/robots.test.js`.

`parseRobots(text) → RobotsTxt` (RFC 9309). `class RobotsTxt`:
- `groups: [{userAgents: string[] (lowercased), rules: [{type:'allow'|'disallow', path:string}], crawlDelay: number|null}]`, `sitemaps: string[]`
- `selectGroup(tokens: string[]) → {matchedAgent: string, rules, crawlDelay} | null` — try each token in order; a
  group matches a token if its user-agent value equals the token case-insensitively (also accept a UA line whose
  value, lowercased, starts with the token followed by `/`). All groups matching the same token are **merged**.
  If no token matches, use merged `*` groups; else `null` (= allow everything).
- `isAllowed(tokens, urlOrPath) → {allowed: boolean, rule: {type,path}|null, matchedAgent: string|null}` —
  longest-match wins (pattern length in octets); on equal length `allow` wins; `*` wildcard, `$` end anchor;
  match against path+query, percent-encoding normalized (decode unreserved chars, uppercase hex) on both sides;
  empty `Disallow:` is ignored; `/robots.txt` is always allowed.
- `crawlDelay(tokens) → seconds|null`
- `static allowAll()`, `static disallowAll()` (disallowAll → `isAllowed` false for everything except /robots.txt)
- Parser: tolerate BOM, CRLF, comments `#`, leading whitespace, unknown directives, case-insensitive keys,
  `useragent`/`user agent` typos not required. Consecutive `User-agent` lines share one group. Rules before any
  user-agent are ignored. `Sitemap:` is global. Limit parsing to first 500 KiB (RFC 9309).

`class RobotsCache`:
- `constructor({ttlMs, fetchRobots: async (robotsUrl, role) => ({status:number /*0 = network error*/, body:string|null, error?:string}), audit?, now?: () => number})`
- `async get(url, role='search') → {robots: RobotsTxt, origin, robotsUrl, status, fetchedAt, expiresAt, source:'network'|'cache'|'stale'}`
  Keyed by origin. 2xx → parse. 4xx (incl 404, 401, 403) → allowAll. 429, 5xx, network error (status 0) →
  if a previous (even expired) copy exists use it (`source:'stale'`) else disallowAll; cache these failures for at most 10 min.
  Concurrent `get` for the same origin must share one in-flight fetch.
- `invalidate(origin)`, `clear()`, `entries() → [{origin, status, fetchedAt, expiresAt, groups: n, sitemaps: string[]}]`
- `async check(url, role) → {allowed, rule, matchedAgent, robotsUrl, crawlDelay, status, source}` (uses `robotsTokens(role)`).

## Module: net (owner: net agent)
Files: `src/net/ratelimit.js`, `src/net/signing.js`, `src/net/fetcher.js`, `test/ratelimit.test.js`, `test/signing.test.js`, `test/fetcher.test.js`.

`class HostScheduler` — `constructor({minDelayMs=1000, maxConcurrencyPerHost=1, globalConcurrency=8, backoffBaseMs=2000, maxBackoffMs=60000, now?, sleep?})`
- `async schedule(host, fn, {crawlDelaySec}={}) → await fn()` — FIFO per host; waits until
  `nextAllowedAt(host) = lastStart + max(minDelayMs, crawlDelaySec*1000)` and `backoffUntil`; per-host and global
  concurrency limits. Must not hold a global slot while waiting on a host delay.
- `penalize(host, retryAfterMs=null)` — exponential backoff (base·2^n, capped; Retry-After wins if larger). `reward(host)` resets.
- `stats() → [{host, inFlight, queued, requests, backoffMs, nextAllowedAt}]`.
- `static parseRetryAfter(value, now) → ms|null` (delta-seconds or HTTP-date).

`class Signer` — Web Bot Auth (IETF draft-meunier-web-bot-auth-architecture, HTTP Message Signatures RFC 9421, Ed25519):
- `constructor({keyDir, config})`; `async init()` loads or generates `keyDir/ed25519-private.pem` + `ed25519-public.pem` (mode 0600 for private).
- `get keyId()` = RFC 7638 JWK thumbprint (SHA-256, base64url) of `{"crv":"Ed25519","kty":"OKP","x":...}`.
- `jwk()`, `jwks() → {keys:[{kty:'OKP', crv:'Ed25519', x, kid, use:'sig', alg:'EdDSA'}]}`.
- `signRequest({method='GET', url, now?}) → headers object` with:
  `Signature-Agent: "<config.publicBaseUrl>"` (sf-string, quoted),
  `Signature-Input: sig1=("@authority" "signature-agent");created=<s>;expires=<s+300>;keyid="<kid>";alg="ed25519";nonce="<b64 random>";tag="web-bot-auth"`,
  `Signature: sig1=:<base64 ed25519 signature>:`.
  Signature base (RFC 9421 §2.5): lines `"@authority": <host[:port] lowercased>` , `"signature-agent": "<url>"`, `"@signature-params": ("@authority" "signature-agent");created=...` joined by `\n`, no trailing newline.
  Returns `{}` when `config.signing.enabled` is false.
- `signResponse(bodyString)`: not required.
- `export function verifyRequest({method, url, headers}, jwks, {now?}) → {valid:boolean, keyid?, reason?, agent?}` —
  headers lowercase-keyed; checks tag, created/expires window, keyid in jwks, signature. Used by fixture site and `/api/verify-signature`.
- `export function jwkThumbprint(jwk) → string`.

`class Fetcher` — `constructor({config, scheduler, signer, audit, fetchImpl = globalThis.fetch})`
- creates `this.robots = new RobotsCache({ttlMs: config.robots.cacheTtlMs, fetchRobots: (robotsUrl, role) => this.fetchRaw(robotsUrl, {role, kind:'robots'}), audit})`
- `async fetch(url, {role='search', respectRobots, accept, maxBytes, signal, method='GET'}={}) → FetchResult`
  - default `respectRobots` = `role==='user' ? config.robots.respectForUserFetch : true`.
  - Pipeline: normalize → scheme check → (optional private-network block) → robots check (skip for /robots.txt)
    → `scheduler.schedule(host, ..., {crawlDelaySec})` → HTTP GET with headers `User-Agent`, `Accept`
    (default `text/html,application/xhtml+xml,text/plain;q=0.9,application/xml;q=0.8,*/*;q=0.5`),
    `Accept-Language: en`, `From: <config.contact>`, + signature headers → manual redirects (≤ maxRedirects,
    **re-check robots on every hop**; cross-origin hops fetch that origin's robots) → read body with maxBytes cap
    (truncate, set `truncated`) and timeout (AbortController) → decode as UTF-8 (respect charset=... when
    TextDecoder supports it) → retries: 429/503/5xx/network error up to `config.fetch.retries` with
    `scheduler.penalize(host, retryAfterMs)`; success → `scheduler.reward(host)`.
  - Every HTTP attempt → one `audit.record({kind:'fetch', ...})`. A robots block → one audit entry with `blocked:'robots'` and status null.
- `async fetchRaw(url, {role='search', kind='fetch'}) → {status, body, headers, error}` — no robots check, still UA/rate limit/signing/audit; follows ≤5 redirects.
- `async checkRobots(url, role) → same as RobotsCache.check`.
- `FetchResult = {ok, url, finalUrl, status, headers:{lowercased:value}, contentType, body:string|null, bytes, truncated, elapsedMs, redirects:[{from,to,status}], blocked:null|{reason:'robots'|'scheme'|'private-network'|'invalid-url', detail, rule?}, error:null|string, role, userAgent, signed:boolean, xRobotsTag:{noindex,nofollow,noarchive,nosnippet}}`
  (`xRobotsTag` parses `X-Robots-Tag` header, including `CairnSearch: noindex` bot-scoped form for the role token).

## Module: text (owner: text agent)
Files: `src/extract/html.js`, `src/extract/sitemap.js`, `src/index/tokenize.js`, `src/index/store.js`, `test/extract.test.js`, `test/index.test.js`.

`extractHtml(html, baseUrl, {botTokens=[]}={}) → {title, description, lang, canonical:string|null, metaRobots:{noindex,nofollow,noarchive,nosnippet}, headings:[{level,text}], text, markdown, links:[{url,text,rel,nofollow}], wordCount}` —
zero-dep tolerant tokenizer; decode entities (named common set + numeric); skip script/style/noscript/template/svg/iframe/head content for text; honor `<base href>`; links normalized via `normalizeUrl` (drop non-http); `metaRobots` merges `<meta name="robots">` and `<meta name="<token>">` for any `botTokens` (case-insensitive), content values `noindex, nofollow, none, noarchive, nosnippet`.
`extractText(body, contentType)` helper: plain text → `{title:first line, text, ...}` same shape.
`parseSitemap(xml) → {type:'urlset'|'sitemapindex'|'text', urls:[{loc,lastmod}], sitemaps:[string]}` (handles plain-text sitemaps, CDATA, entities).

`tokenize(text) → string[]` lowercase, Unicode letters/digits, stopwords removed, light English stemming (plural s/es/ies, ing, ed). Same function for docs and queries.

`class SearchIndex` — `constructor({file=null})`
- `add(doc) → 'added'|'updated'|'unchanged'` doc: `{url, title, description, text, markdown, headings, lang, site, fetchedAt, role, contentHash, canonical, noarchive, nosnippet}`; computes `contentHash` (sha256 of text) if missing; `unchanged` when hash equal. Splits text into passages (~120 words, 20 overlap) for RAG.
- `remove(url)`, `has(url)`, `get(url)`, `findByHash(hash) → url|null`, `clear()`.
- `search(query, {limit=10, offset=0, site}) → {query, total, tookMs, results:[{url,title,snippet,score,site,fetchedAt}]}` — BM25 (k1 1.2, b 0.75) over body + title (title weight ×2.5) + phrase/proximity bonus optional; snippet ≈ 30-word best window (plain text; '' if nosnippet).
- `searchPassages(query, {limit=8}) → [{url,title,text,score}]` (for RAG; never include nosnippet docs' text beyond title).
- `list({site, limit=50, offset=0}) → {total, docs:[{url,title,site,fetchedAt,wordCount,role}]}`; `stats() → {docs, passages, terms, sites:[{site,docs}], lastUpdated}`.
- `async save()` (atomic write tmp+rename, JSON of docs only; postings rebuilt on load), `async load()`, `scheduleSave(ms=1000)` debounced.

## Module: crawl (owner: crawl agent)
Files: `src/crawl/crawler.js`, `src/crawl/jobs.js`, `src/crawl/corpus.js`, `test/crawler.test.js`.

`class CrawlJob extends EventEmitter` — `constructor(opts, {config, fetcher, index, audit})`, opts:
`{id, seeds:[url], role:'search'|'corpus', maxPages, maxDepth, sameSiteOnly, useSitemaps, concurrency, includePatterns?:[string regex], excludePatterns?:[string]}` (defaults from `config.crawl`).
- `async run()`: for each seed origin: `fetcher.checkRobots` (pulls robots) → seed sitemaps from robots `Sitemap:` lines, plus `/sitemap.xml` if useSitemaps (follow sitemap indexes up to 3 levels, cap 1000 URLs) → BFS frontier (depth; sitemap URLs depth 1) → `fetcher.fetch(url, {role})`
  → outcomes: `blocked-robots`, `error`, `http-<status>`, `skipped-type` (non html/text), `noindex` (meta or X-Robots-Tag; still follow links unless nofollow), `duplicate` (content hash or canonical already indexed), `indexed`, `collected` (corpus).
  → extract with `botTokens: robotsTokens(role)`; enqueue links unless page nofollow / link rel=nofollow; scope by sameSiteOnly + include/exclude; canonical respected.
  → role `search`: `index.add(...)`, then `index.scheduleSave()`. role `corpus`: append `{url,title,text,fetchedAt,contentHash}` JSONL to `<dataDir>/corpus/<jobId>.jsonl` via `src/crawl/corpus.js`; do NOT add to the search index.
- `cancel()`; `status() → {id, state:'queued'|'running'|'done'|'cancelled'|'error', role, seeds, options, startedAt, finishedAt, counts:{discovered,queued,fetched,indexed,collected,blockedRobots,noindex,duplicates,errors,skipped}, inFlight:[url], recent:[{url,outcome,status,title,depth,ts}] (last 50), error}`
- events: `'page'` `{jobId,url,outcome,status,title,depth}`, `'state'` status, `'done'` status.
- Crawl-delay and politeness come from Fetcher/HostScheduler — the crawler must not add its own sleeps.

`class JobManager` — `constructor({config, fetcher, index, audit})`; `create(opts) → CrawlJob` (starts immediately, id like `job-<n>-<base36 time>`); `list() → [status]` newest first; `get(id)`; `cancel(id)`; `cancelAll()`; `async waitFor(id, timeoutMs) → status`. Keep last 50 jobs.

## Module: agent (owner: agent agent)
Files: `src/agent/claude.js`, `src/agent/answer.js`, `src/agent/research.js`, `src/agent/mcp-server.js`, `test/agent.test.js`, `test/mcp.test.js`, `test/fixtures/fake-claude.js` (fake CLI for tests).

`claude.js`:
- `async claudeAvailable(config) → {available, version, bin, error?}` (runs `<bin> --version`, cached 60 s).
- `runClaude({config, prompt, systemPrompt, model, mcpConfig /*object*/, allowedTools=[], builtinTools='' , jsonSchema, maxBudgetUsd, timeoutMs, cwd, onEvent, signal}) → Promise<{ok, text, costUsd, durationMs, sessionId, numTurns, isError, error, raw}>`
  spawn `config.agent.claudeBin` with args: `-p --output-format stream-json --verbose --no-session-persistence --model <m> --tools <builtinTools> --strict-mcp-config [--mcp-config <tmpfile.json>] [--allowedTools a,b] [--system-prompt ...] [--max-budget-usd n] --permission-prompts none`; prompt via **stdin**; cwd defaults to `<dataDir>/agent-work` (created, empty — avoids loading project CLAUDE.md).
  Parse NDJSON stdout: `system/init`, `assistant` (message.content[] of `text` / `tool_use{name,input}`), `user` (tool_result), `result` (`result`, `total_cost_usd`, `is_error`, `duration_ms`, `num_turns`, `session_id`). Emit normalized events to `onEvent`: `{type:'status'|'text'|'tool'|'tool_result'|'result', ...}`. Kill on timeout/signal.
  Verify flag compatibility against the real CLI once (`claude --help`; a live haiku call costs cents — allowed, max 2 live calls).
- `answer.js`: `async answerQuestion(question, {runtime, onEvent, model}) → {question, answer (markdown, cites like [1]), citations:[{n,url,title}], usedClaude, mode:'quick', costUsd, elapsedMs, passages}` — retrieve `runtime.index.searchPassages(q, {limit: config.agent.maxPassages})`; if none → answer says the index has nothing relevant + suggest crawl; prompt Claude (no tools) with numbered sources, instruct: answer only from sources, cite [n], say when unknown. Fallback when Claude unavailable/fails: extractive answer (top 3 passages, cited), `usedClaude:false`. Record `audit.record({kind:'agent', ...})`.
- `research.js`: `async deepResearch(question, {runtime, apiUrl, onEvent, model, allowLiveFetch=true}) → {question, answer, citations, usedClaude:true, mode:'deep', costUsd, elapsedMs, steps:[{type,name,input,summary,ts}]}` — writes MCP config `{mcpServers:{cairn:{command: process.execPath, args:[<abs path mcp-server.js>], env:{CAIRN_API: apiUrl, CAIRN_SOURCES_FILE: <tmp json>}}}}`, allowedTools = `mcp__cairn__search_index, mcp__cairn__fetch_page, mcp__cairn__crawl_site, mcp__cairn__check_robots, mcp__cairn__index_stats`, builtinTools `''`. System prompt: research agent; search index first, fetch pages via tools only, crawl small scopes, respect tool refusals (robots), finish with markdown answer citing `[n]` source ids returned by tools. After run read sources file → citations (only those cited, in order).
- `mcp-server.js`: stdio MCP server (JSON-RPC 2.0, newline-delimited JSON, **stdout only for protocol**, logs to stderr).
  Handles `initialize` (echo client protocolVersion or `2025-06-18`; `capabilities:{tools:{}}`; `serverInfo:{name:'cairn',version:'1.0.0'}`), `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Unknown method → error -32601.
  Tools (proxy to the running Cairn HTTP API at `process.env.CAIRN_API`):
  `search_index {query, limit?}` → POST /api/search; `fetch_page {url}` → POST /api/fetch `{url, role:'user', index:true}` returns title + markdown (≤ 12k chars) or refusal text if blocked by robots; `crawl_site {url, maxPages? (≤25), maxDepth? (≤2)}` → POST /api/crawl then poll GET /api/crawl/:id up to 90 s; `check_robots {url, role?}` → POST /api/robots/check; `index_stats {}` → GET /api/stats.
  Every URL surfaced gets a stable source id `[n]` (session registry), written to `CAIRN_SOURCES_FILE` as `[{n,url,title}]` after each change. Tool results: `{content:[{type:'text', text}], isError?}`.

## Module: server + CLI (owner: server agent)
Files: `src/server/app.js`, `src/server/api.js`, `src/server/sse.js`, `src/server/botpage.js`, `bin/cairn.js`, `test/server.test.js`.

`async startServer({runtime, port=config.port, host=config.host}) → {server, url, runtime, close()}` (`port:0` allowed). After listen, if `!config.publicBaseUrlExplicit`, set `config.publicBaseUrl = url`.
Security: bind 127.0.0.1; reject requests whose `Host` isn't `127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding guard) with 421; POST/DELETE require `Content-Type: application/json` and, if an `Origin` header is present, it must equal the server origin (CSRF guard) → 403; no CORS headers; JSON bodies ≤ 1 MB; security headers (`X-Content-Type-Options: nosniff`, CSP for HTML `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`).
Routes (JSON unless noted):
- `GET /` → `web/index.html`; `GET /web/*` static from `web/`; `GET /docs/` + `/docs/*` static from `docs/` (index.html default).
- `GET /bot` → HTML site-owner page (botpage.js): what Cairn is, each role (token, full UA, purpose, robots behaviour), robots.txt examples (block all / block corpus only / allow search), IP range JSON links, Web Bot Auth key directory link + keyid, verification steps, contact. Style inline or `/docs/assets/docs.css`.
- `GET /bot/cairnsearch.json`, `/bot/cairncorpus.json`, `/bot/cairn-user.json` → `{creationTime, prefixes:[{ipv4Prefix}|{ipv6Prefix}]}` from `config.identity`.
- `GET /.well-known/http-message-signatures-directory` → `signer.jwks()` with `Content-Type: application/http-message-signatures-directory+json`.
- `GET /api/health` → `{ok:true, name:'Cairn', version, uptimeSec, claude: await claudeAvailable(config)}`
- `GET /api/identity` → `{roles:[{id,token,name,purpose,trigger,respectsRobots,userAgent}], familyToken, keyId, jwksUrl, botPageUrl, contact}`
- `GET|POST /api/search` (`q`/`query`, `limit`, `site`) → `index.search(...)`
- `POST /api/ask` `{question, mode:'quick'|'deep', model?}` → final result JSON (blocking). `GET /api/ask/stream?question=&mode=` → SSE: events `status|retrieval|tool|tool_result|text|answer|error` (data JSON) then `event: done`.
- `POST /api/crawl` `{seeds|url, role, maxPages, maxDepth, sameSiteOnly, useSitemaps, includePatterns, excludePatterns}` → `{job: status}` (201). `GET /api/crawl` → `{jobs}`. `GET /api/crawl/:id` → status. `POST /api/crawl/:id/cancel`. `GET /api/crawl/:id/events` → SSE `page`/`state`/`done`.
- `POST /api/fetch` `{url, role='user', index=false}` → `{result: FetchResult minus body, extracted: {title, description, markdown (≤ 20k), links (≤ 200), metaRobots, headings, wordCount}|null, indexed: outcome|null, robots: check}`; when `index:true` and allowed and not noindex → `index.add` (role user).
- `POST /api/robots/check` `{url, role?, robotsTxt?}` → if `robotsTxt` provided, parse locally and evaluate for all roles; else via `fetcher.checkRobots` → `{url, robotsUrl, decisions:[{role, token, allowed, rule, matchedAgent}], crawlDelay, sitemaps, source}`. `GET /api/robots/cache` → `{entries}`. `POST /api/robots/cache/clear`.
- `GET /api/index?site=&limit=&offset=` → `{stats, ...list}`; `GET /api/index/doc?url=` → doc; `DELETE /api/index/doc?url=`; `POST /api/index/clear`.
- `GET /api/audit?limit=&role=&kind=` → `{entries, stats}`; `GET /api/audit/stream` → SSE `entry`.
- `GET /api/stats` → `{index: stats, audit: stats, hosts: scheduler.stats(), jobs: list, robotsCache: n, uptimeSec}`.
- `GET /api/config` → editable subset; `POST /api/config` partial → `saveConfig` → new subset.
- `POST /api/verify-signature` `{url, headers}` → `verifyRequest(..., signer.jwks())`.
- `POST /api/sign-preview` `{url}` → headers that would be sent (for the UI).
Errors: `{error: message}` with 4xx/5xx. Unknown → 404.

`bin/cairn.js` (shebang `#!/usr/bin/env node`, hand-rolled arg parsing, `--json` flag where useful, `--data-dir`):
`serve [--port] [--open]`, `crawl <url...> [--role search|corpus] [--max-pages] [--max-depth] [--no-sitemaps] [--any-site]` (prints live progress), `search <q> [--limit]`, `ask <question> [--deep] [--model]` (deep starts an in-process server on port 0 for the MCP bridge), `fetch <url> [--role] [--index]`, `robots <url>` (decisions for all roles), `keys` (JWKS + keyid), `stats`, `audit [--limit]`, `index list|clear|remove <url>`, `doctor` (node version, claude availability, data dir writable, key present), `fixture [--port 8788]` (starts demo site, `fixtures/site-server.js`), `demo` (start fixture on ephemeral port → crawl it → search → ask quick; prints results), `help`.

## Module: web UI (owner: web agent)
Files: `web/index.html`, `web/app.js`, `web/styles.css`. Vanilla JS (ES module), no CDN, no framework. Talks only to the API above (POST with `Content-Type: application/json`).
Views (left nav / tabs): **Ask** (chat-like; quick/deep toggle; streaming via `EventSource('/api/ask/stream?...')`; render markdown safely (escape then minimal md: headings, bold, code, lists, links); citations `[n]` become links to sources; research step timeline for deep), **Crawl** (form: seeds, role, maxPages, maxDepth, sameSite, sitemaps; job list with live counts via SSE; per-job page outcomes table with colored outcome chips), **Index** (search box → results with highlighted terms; site breakdown; doc viewer drawer; delete), **Fetch inspector** (url + role → robots decision, request headers incl. UA + signature headers (from /api/sign-preview), response status/headers, redirects, extracted markdown, links), **Robots tester** (url + optional pasted robots.txt → decisions per role with matched rule), **Audit** (live table via `/api/audit/stream`, filters), **Identity** (roles/UA cards, keyid, JWKS JSON, IP JSON links, link to /bot and /docs/), **Settings** (politeness, respect robots for user fetch, model, budget → POST /api/config). Header shows health (claude available?). Polished modern design, light/dark via `prefers-color-scheme`. Never use `innerHTML` with unescaped server data.

## Module: fixture + e2e (owner: fixture agent)
Files: `fixtures/site-server.js`, `test/e2e.test.js`, `test/live-claude.test.js`.
`export async function startFixtureSite({port=0, host='127.0.0.1'}={}) → {url, close(), requests: [{ts, method, path, headers}], reset()}`; runnable directly (`node fixtures/site-server.js --port 8788`).
Fictional outdoor-gear company **"Northwind Trails"** with factual content usable for Q&A (e.g. product *Ridgeback 45* backpack weighs 1.2 kg, costs $189, 45 L; *Summit Shell* jacket $249, 20k mm waterproof; returns within 60 days; HQ in Boise, Idaho; founded 2011; warranty lifetime on packs). Routes:
- `/robots.txt`:
  ```
  User-agent: *
  Disallow: /private/
  Disallow: /admin/

  User-agent: CairnSearch
  Allow: /private/public-note.html
  Disallow: /private/
  Disallow: /*.pdf$
  Disallow: /search?

  User-agent: CairnCorpus
  Disallow: /

  Sitemap: <base>/sitemap.xml
  ```
- `/` (links to about, products, blog, faq, nofollow, noindex, xrobots, redirect, redirect-to-private, canonical-dup, dup-content, file.pdf, data.json, search?q=x), `/about.html`, `/products/ridgeback-45.html`, `/products/summit-shell.html`, `/blog/` + `/blog/post-1.html`…`/blog/post-3.html` (depth chain: post-3 links `/blog/deep/level-3.html` → `/blog/deep/level-4.html`), `/faq.html` (returns/warranty), `/private/secret.html`, `/private/public-note.html`, `/admin/index.html`, `/noindex.html` (meta robots noindex, links to `/via-noindex.html`), `/xrobots.html` (`X-Robots-Tag: noindex`), `/nofollow.html` (meta robots nofollow, links to `/hidden-behind-nofollow.html`), `/rel-nofollow.html` (a `rel=nofollow` link to `/hidden-rel-nofollow.html`), `/redirect` (301 → /about.html), `/redirect-to-private` (302 → /private/secret.html), `/rate-limited` (429 + `Retry-After: 1` on first request per server lifetime, then 200), `/flaky` (503 first time, then 200), `/file.pdf`, `/data.json`, `/canonical-dup.html` (canonical → /about.html), `/dup-content.html` (identical body text to /blog/post-1.html), `/orphan.html` (only in sitemap), `/sitemap.xml` (a sitemapindex → `/sitemap-pages.xml`), `/signed-only` (200 `{verified:true, keyid, agent}` only if Web Bot Auth verifies: fetch `<Signature-Agent>/.well-known/http-message-signatures-directory` and `verifyRequest`; else 401), `/echo-headers` (JSON of request headers), `/slow` (responds after 3 s).
- e2e test: `createRuntime({dataDir: tmp, politeness:{minDelayMs:0,...}})` + fixture → crawl (search role) → assert: private pages never requested (check `fixture.requests`), public-note indexed, noindex/xrobots not indexed, nofollow target not discovered via links, orphan found via sitemap, pdf never requested, corpus-role crawl requests only /robots.txt, UA header contains `CairnSearch/1.0` and `+…/bot`, redirect-to-private blocked, 429 retried; start server (port 0) → `/signed-only` via user fetch verifies; search returns Ridgeback; `answerQuestion` with fake claude (`CAIRN_CLAUDE_BIN=test/fixtures/fake-claude.js`) returns citation.
- live-claude test (only when `CAIRN_LIVE_CLAUDE=1`): real quick answer + real deep research on fixture ("How much does the Ridgeback 45 weigh and what is the return window?") expects "1.2" and "60" and ≥1 citation.

## Module: docs (owners: docs-a, docs-b)
HTML pages in `docs/` using `docs/assets/docs.css` + local Mermaid (`<script src="assets/mermaid.min.js"></script><script>mermaid.initialize({startOnLoad:true, theme:'default', securityLevel:'strict'})</script>` — use `<pre class="mermaid">` blocks). Shared layout: see the HTML skeleton in `docs/assets/TEMPLATE.html`.
Pages: `index.html` (overview, name, highlights, quick start, page map), `features.html` (researched feature catalogue: OpenAI bots, xAI-Bot, Anthropic bots, industry standards → Cairn implementation & status table), `architecture.html` (C4-ish context/container/component diagrams, module map, data stores, runtime wiring), `workflows.html` (≥ 10 diagrams: crawl lifecycle, fetch pipeline sequence, robots decision flowchart, robots cache state machine, rate-limit/backoff state machine, redirect handling, quick-answer RAG sequence, deep research agent loop (Claude CLI ↔ MCP ↔ API ↔ Fetcher), Web Bot Auth signing & verification sequence, crawl job state diagram, indexing pipeline, SSE event flow, CLI demo flow), `robots.html`, `web-bot-auth.html` (identity & verification), `agent.html` (Claude CLI + MCP design, prompts, safety), `api.html`, `cli.html`, `site-owners.html`, `security.html`, `testing.html`, `naming.html`.
