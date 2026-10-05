#!/usr/bin/env node
// Cairn command-line interface. Heavy modules are imported lazily per command
// so `cairn help` and `cairn doctor` stay fast and work even on a partial install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL_STATES = new Set(['done', 'cancelled', 'error']);

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['json', 'open', 'deep', 'index', 'no-sitemaps', 'any-site', 'help', 'version', 'no-color', 'keep', 'no-claude', 'full', 'all', 'always', 'rebuild', 'restart', 'quit', 'install', 'no-launch', 'no-dock', 'no-follow']);
const VALUE_FLAGS = new Set(['data-dir', 'port', 'host', 'role', 'max-pages', 'max-depth', 'concurrency', 'include', 'exclude', 'limit', 'site', 'model', 'file', 'kind', 'conversation', 'message']);
const SHORT_FLAGS = { h: 'help', v: 'version', n: 'limit', p: 'port', j: 'json' };

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const set = (name, value) => {
    if (name in flags && VALUE_FLAGS.has(name)) flags[name] = [].concat(flags[name], value);
    else flags[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name;
    let value;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      value = eq === -1 ? undefined : arg.slice(eq + 1);
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      name = SHORT_FLAGS[arg[1]];
      if (!name) throw new UsageError(`Unknown option ${arg}`);
    } else {
      positionals.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      set(name, value === undefined ? true : !['false', '0', 'no'].includes(value.toLowerCase()));
    } else if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`Option --${name} needs a value`);
        i++;
      }
      set(name, value);
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { positionals, flags };
}

function lastValue(v) {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function listValue(v) {
  return v === undefined ? undefined : [].concat(v);
}

function intFlag(flags, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = lastValue(flags[name]);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let colorOn = false;
function decideColor(flags) {
  if (flags['no-color']) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}
const paint = (open) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[0m` : String(s));
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const blue = paint(34);
const magenta = paint(35);
const cyan = paint(36);

const out = (s = '') => process.stdout.write(`${s}\n`);
const info = (s = '') => process.stderr.write(`${s}\n`);
const printJson = (v) => out(JSON.stringify(v, null, 2));

function heading(s) {
  out(`\n${bold(s)}`);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function outcomeLabel(outcome) {
  const o = String(outcome || '?');
  const padded = o.padEnd(14);
  if (o === 'indexed' || o === 'collected') return green(padded);
  if (o === 'noindex' || o === 'duplicate') return yellow(padded);
  if (o === 'blocked-robots') return magenta(padded);
  if (o === 'skipped-type') return dim(padded);
  return red(padded);
}

function allowedLabel(allowed) {
  if (allowed === true) return green('allowed   ');
  if (allowed === false) return red('disallowed');
  return yellow('unknown   ');
}

function ruleText(rule) {
  return rule ? `${rule.type}: ${rule.path}` : '(no matching rule)';
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

function dataDirOverride(flags) {
  const dir = lastValue(flags['data-dir']);
  return dir ? { dataDir: path.resolve(dir) } : {};
}

async function openRuntime(flags, overrides = {}) {
  const { createRuntime } = await import('../src/runtime.js');
  return createRuntime({ ...dataDirOverride(flags), ...overrides });
}

async function withRuntime(flags, fn, overrides) {
  const runtime = await openRuntime(flags, overrides);
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

function waitForSignal() {
  return new Promise((resolve) => {
    const done = (sig) => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve(sig);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => info(yellow(`Could not open a browser (${err.message}); visit ${url}`)));
    child.unref();
  } catch (err) {
    info(yellow(`Could not open a browser (${err.message}); visit ${url}`));
  }
}

// Runs a crawl job to completion, printing one line per page.
async function runCrawl(runtime, opts, { stream = process.stdout } = {}) {
  const job = runtime.jobs.create(opts);
  const write = (s) => stream.write(`${s}\n`);
  const started = Date.now();
  job.on('page', (p) => {
    const status = p.status === null || p.status === undefined ? '---' : String(p.status);
    const secs = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
    write(`${dim(secs + 's')}  ${outcomeLabel(p.outcome)} ${dim(status.padStart(3))}  ${dim(`d${p.depth ?? '?'}`)}  ${p.url}${p.title ? dim(`  — ${truncate(p.title, 60)}`) : ''}`);
  });

  let cancelled = false;
  const onSigint = () => {
    if (cancelled) process.exit(130);
    cancelled = true;
    info(yellow('\nCancelling crawl… (Ctrl-C again to quit immediately)'));
    runtime.jobs.cancel(job.id);
  };
  process.on('SIGINT', onSigint);
  try {
    await new Promise((resolve) => {
      const check = (s) => {
        if (s && TERMINAL_STATES.has(s.state)) resolve();
      };
      job.once('done', resolve);
      job.on('state', check);
      check(job.status());
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
  return job.status();
}

function printCounts(status) {
  const c = status.counts || {};
  const parts = [
    ['fetched', c.fetched, blue],
    ['indexed', c.indexed, green],
    ['collected', c.collected, green],
    ['noindex', c.noindex, yellow],
    ['duplicates', c.duplicates, yellow],
    ['blocked by robots', c.blockedRobots, magenta],
    ['skipped', c.skipped, dim],
    ['errors', c.errors, red],
  ];
  out(`${bold('Job')} ${status.id}  ${bold('state')} ${status.state === 'done' ? green(status.state) : yellow(status.state)}  ${dim(`(${c.discovered ?? 0} discovered)`)}`);
  out(parts.map(([label, n, color]) => `${color(String(n ?? 0))} ${label}`).join(dim(' · ')));
  if (status.error) out(red(`error: ${status.error}`));
}

function printSearch(res) {
  if (!res.results?.length) {
    out(dim(`No results for "${res.query}".`));
    return;
  }
  out(dim(`${res.total} result${res.total === 1 ? '' : 's'} for "${res.query}" in ${res.tookMs} ms`));
  res.results.forEach((r, i) => {
    out(`\n${bold(`${i + 1}. ${r.title || r.url}`)}  ${dim(`score ${Number(r.score).toFixed(2)}`)}`);
    out(`   ${cyan(r.url)}`);
    if (r.snippet) out(`   ${truncate(r.snippet, 240)}`);
  });
}

function printAnswer(result) {
  out(`\n${result.answer}\n`);
  if (result.citations?.length) {
    out(bold('Sources'));
    for (const c of result.citations) out(`  [${c.n}] ${c.title || c.url}  ${cyan(c.url)}`);
  }
  const bits = [`mode ${result.mode}`, result.usedClaude ? green('answered by Claude') : yellow('extractive fallback (Claude not used)')];
  if (result.costUsd) bits.push(`$${Number(result.costUsd).toFixed(4)}`);
  if (result.elapsedMs !== undefined) bits.push(`${(result.elapsedMs / 1000).toFixed(1)} s`);
  out(dim(bits.join(' · ')));
}

function askEventPrinter() {
  return (ev) => {
    if (!ev) return;
    if (ev.type === 'status' && ev.message) info(dim(`· ${ev.message}`));
    else if (ev.type === 'retrieval') info(dim(`· retrieved ${ev.passages?.length ?? 0} passage(s)`));
    else if (ev.type === 'tool') info(`${blue('→')} ${ev.name} ${dim(truncate(JSON.stringify(ev.input ?? {}), 140))}`);
    else if (ev.type === 'tool_result') info(`${ev.isError ? red('←') : green('←')} ${dim(truncate(String(ev.summary ?? ev.text ?? '').replace(/\s+/g, ' '), 140))}`);
  };
}

function readAuditFile(dataDir) {
  const file = path.join(dataDir, 'audit.ndjson');
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip a partially written trailing line.
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const HELP = `Cairn — transparent, robots.txt-respecting retrieval & answer engine

Usage: cairn <command> [options]

Commands
  serve [--port N] [--host H] [--open]      Start the web UI + API (default http://127.0.0.1:8787)
  crawl <url...> [options]                  Crawl and index (or collect) a site, printing live progress
      --role search|corpus  --max-pages N  --max-depth N  --concurrency N
      --no-sitemaps  --any-site  --include <regex>  --exclude <regex>
  search <query> [--limit N] [--site S]     Search the local index
  ask <question> [--deep] [--model M]       Answer from the index (quick) or run the research agent (deep)
  fetch <url> [--role user|search|corpus] [--index] [--full]
                                            Fetch one page as Cairn and show robots decision + extraction
  robots <url> [--file robots.txt]          robots.txt decisions for every Cairn agent
  keys                                      Web Bot Auth key id and JWKS
  stats                                     Index and audit-log statistics
  audit [--limit N] [--role R] [--kind K]   Recent network activity from the audit log
  index list [--site S] [--limit N] | index clear | index remove <url>
  doctor                                    Check Node, Claude CLI, data dir, signing key and desktop app
  fixture [--port 8788]                     Run the Northwind Trails demo site
  demo [--no-claude] [--keep]               Fixture site → crawl → search → answer, end to end
  help                                      Show this help

Assistant (talk to the running server — start it with \`serve\` or \`desktop\`)
  chat <message> [--conversation ID] [--no-follow]
                                            Ask the assistant; streams text, tool steps and approvals
  remind <text>                             Schedule a reminder, e.g. "in 10 minutes stretch",
                                            "tomorrow at 9am call mom", "every weekday at 8:30 standup"
  tasks [list [--all] | cancel <id> | run <id>]
                                            Upcoming reminders and recurring tasks
  approvals [list | approve <id> [--always] | deny <id> [--message M]]
                                            Tool calls waiting for your decision
  shopping                                  The shopping list (Cairn never pays for anything)
  assistant                                 Open the full-page assistant in your browser
  desktop [--rebuild | --restart | --quit]  Launch the floating desktop bubble (the installed app, else the build)
  desktop --install [--no-launch] [--no-dock]
                                            Build if needed, install Cairn.app into /Applications and keep it
                                            in the Dock (--no-dock: leave the Dock alone); then start it from the
                                            Dock, Launchpad or Spotlight; re-run after code changes
      (assistant commands use http://127.0.0.1:<port>; --port overrides the configured port)

Global options
  --data-dir <dir>   Data directory (default ./data or $CAIRN_HOME)
  --json             Machine-readable output (search, robots, stats, fetch, ask, crawl, keys, audit, doctor)
  --no-color         Disable colours (NO_COLOR is also respected)
`;

async function cmdServe({ flags }) {
  const port = intFlag(flags, 'port', { min: 0, max: 65535 });
  const host = lastValue(flags.host);
  const runtime = await openRuntime(flags, port !== undefined ? { port } : {});
  const { startServer } = await import('../src/server/app.js');
  let srv;
  try {
    srv = await startServer({ runtime, port, host });
  } catch (err) {
    await runtime.close();
    if (err.code === 'EADDRINUSE') throw new Error(`Port ${port ?? runtime.config.port} is already in use (is Cairn already running? try --port 0)`);
    throw err;
  }
  out(`${bold('Cairn')} is listening on ${cyan(srv.url)}`);
  out(`  UI          ${srv.url}/`);
  out(`  Site owners ${srv.url}/bot`);
  out(`  Assistant   ${srv.url}/assistant`);
  out(`  Docs        ${srv.url}/docs/`);
  out(`  Data        ${runtime.config.dataDir}`);
  out(`  Key id      ${runtime.signer.keyId}`);
  if (srv.assistant) out(`  Scheduler   ${green('running')} ${dim('(reminders and recurring tasks fire while this server runs)')}`);
  out(dim('Desktop bubble: node bin/cairn.js desktop'));
  out(dim('Press Ctrl-C to stop.'));
  if (flags.open) openInBrowser(`${srv.url}/`);
  await waitForSignal();
  info(dim('\nShutting down…'));
  await srv.close();
  await runtime.close();
  return 0;
}

async function cmdCrawl({ args, flags }) {
  if (!args.length) throw new UsageError('crawl needs at least one URL');
  const { crawlOptions } = await import('../src/server/api.js');
  return withRuntime(flags, async (runtime) => {
    const body = {
      seeds: args,
      role: lastValue(flags.role) || 'search',
      maxPages: intFlag(flags, 'max-pages', { min: 1 }),
      maxDepth: intFlag(flags, 'max-depth', { min: 0 }),
      concurrency: intFlag(flags, 'concurrency', { min: 1, max: 32 }),
      useSitemaps: flags['no-sitemaps'] ? false : undefined,
      sameSiteOnly: flags['any-site'] ? false : undefined,
      includePatterns: listValue(flags.include),
      excludePatterns: listValue(flags.exclude),
    };
    const opts = crawlOptions(body, runtime.config);
    const { ROLES } = await import('../src/identity.js');
    const cfg = runtime.config.crawl;
    const log = flags.json ? info : out;
    log(`${bold('Crawling')} ${opts.seeds.join(', ')} as ${cyan(ROLES[opts.role].token)} ${dim(`(max ${opts.maxPages ?? cfg.maxPages} pages, depth ${opts.maxDepth ?? cfg.maxDepth}, ${runtime.config.politeness.minDelayMs} ms/host)`)}`);
    const status = await runCrawl(runtime, opts, { stream: flags.json ? process.stderr : process.stdout });
    if (flags.json) printJson(status);
    else {
      out('');
      printCounts(status);
      if (opts.role === 'corpus') {
        const corpusPath = path.join(runtime.config.dataDir, 'corpus', `${status.id}.jsonl`);
        out(dim(status.counts?.collected > 0 && fs.existsSync(corpusPath) ? `Corpus written to ${corpusPath}` : 'No pages were collected, so no corpus file was written.'));
      }
    }
    return status.state === 'error' ? 1 : 0;
  });
}

async function cmdSearch({ args, flags }) {
  const q = args.join(' ').trim();
  if (!q) throw new UsageError('search needs a query');
  return withRuntime(flags, async (runtime) => {
    const res = runtime.index.search(q, { limit: intFlag(flags, 'limit', { min: 1, max: 100 }) ?? 10, site: lastValue(flags.site) });
    if (flags.json) {
      printJson(res);
      return 0;
    }
    if (!runtime.index.stats().docs) out(yellow('The index is empty — run `cairn crawl <url>` first.'));
    printSearch(res);
    return 0;
  });
}

async function cmdAsk({ args, flags }) {
  const question = args.join(' ').trim();
  if (!question) throw new UsageError('ask needs a question');
  const { ask } = await import('../src/server/api.js');
  return withRuntime(flags, async (runtime) => {
    let srv = null;
    if (flags.deep) {
      // The research agent reaches Cairn through the MCP bridge, which talks HTTP to this in-process server.
      const { startServer } = await import('../src/server/app.js');
      srv = await startServer({ runtime, port: 0, assistant: false });
      info(dim(`· research bridge listening on ${srv.url}`));
    }
    try {
      const result = await ask(runtime, {
        question,
        mode: flags.deep ? 'deep' : 'quick',
        model: lastValue(flags.model),
        apiUrl: srv?.url,
        onEvent: askEventPrinter(),
      });
      if (flags.json) printJson(result);
      else printAnswer(result);
      return 0;
    } finally {
      await srv?.close();
    }
  });
}

async function cmdFetch({ args, flags }) {
  if (!args[0]) throw new UsageError('fetch needs a URL');
  const { fetchAndExtract } = await import('../src/server/api.js');
  return withRuntime(flags, async (runtime) => {
    const res = await fetchAndExtract(runtime, { url: args[0], role: lastValue(flags.role) || 'user', index: Boolean(flags.index) });
    if (flags.json) {
      printJson(res);
      return 0;
    }
    const r = res.result;
    heading('Request');
    out(`  URL         ${r.url}`);
    out(`  Agent       ${r.userAgent || ''}`);
    out(`  Signed      ${r.signed ? green('yes (Web Bot Auth)') : dim('no')}`);
    if (res.robots) out(`  robots.txt  ${allowedLabel(res.robots.allowed).trim()} ${dim(ruleText(res.robots.rule))}${res.robots.matchedAgent ? dim(` [group ${res.robots.matchedAgent}]`) : ''}`);
    heading('Response');
    if (r.blocked) out(`  ${magenta('Blocked')}     ${r.blocked.reason}${r.blocked.detail ? dim(` — ${r.blocked.detail}`) : ''}`);
    if (r.error) out(`  ${red('Error')}       ${r.error}`);
    if (r.status !== null && r.status !== undefined) out(`  Status      ${r.status >= 400 ? red(r.status) : green(r.status)}  ${dim(r.contentType || '')}`);
    for (const hop of r.redirects || []) out(`  Redirect    ${hop.status} ${hop.from} → ${hop.to}`);
    if (r.finalUrl && r.finalUrl !== r.url) out(`  Final URL   ${r.finalUrl}`);
    out(`  Size        ${r.bytes ?? 0} bytes${r.truncated ? yellow(' (truncated)') : ''} in ${r.elapsedMs ?? 0} ms`);
    const ex = res.extracted;
    if (ex) {
      heading(ex.title || '(untitled)');
      if (ex.description) out(dim(ex.description));
      out(dim(`${ex.wordCount} words · ${ex.linkCount} links · ${ex.headings.length} headings`));
      const flagsOn = Object.entries(ex.metaRobots || {}).filter(([, v]) => v).map(([k]) => k);
      if (flagsOn.length) out(yellow(`meta robots: ${flagsOn.join(', ')}`));
      out('');
      out(flags.full ? ex.markdown : truncate(ex.markdown, 2000));
      if (!flags.full && ex.markdown.length > 2000) out(dim('… (use --full or --json for everything)'));
    }
    if (flags.index) out(`\nIndexed: ${res.indexed ? green(res.indexed) : dim('no')}`);
    return r.ok ? 0 : 1;
  });
}

async function cmdRobots({ args, flags }) {
  if (!args[0]) throw new UsageError('robots needs a URL');
  const file = lastValue(flags.file);
  const robotsTxt = file ? fs.readFileSync(path.resolve(file), 'utf8') : undefined;
  const { robotsDecisions } = await import('../src/server/api.js');
  return withRuntime(flags, async (runtime) => {
    const res = await robotsDecisions(runtime, { url: args[0], robotsTxt, role: lastValue(flags.role) });
    if (flags.json) {
      printJson(res);
      return 0;
    }
    // With --file the rules came from the local file, not the site's live robots.txt.
    const source = file ? `${path.resolve(file)} ${dim('(local file)')}` : `${res.robotsUrl} ${dim(`(source: ${res.source}${res.status ? `, HTTP ${res.status}` : ''})`)}`;
    out(`${bold('robots.txt')} ${source}`);
    out(dim(`Target: ${res.url}`));
    out('');
    for (const d of res.decisions) {
      out(`  ${d.token.padEnd(12)} ${allowedLabel(d.allowed)}  ${ruleText(d.rule)}${d.matchedAgent ? dim(`  [group: ${d.matchedAgent}]`) : dim('  [no matching group]')}${d.crawlDelay ? dim(`  crawl-delay ${d.crawlDelay}s`) : ''}`);
    }
    if (res.sitemaps?.length) out(dim(`\nSitemaps: ${res.sitemaps.join(', ')}`));
    return 0;
  });
}

async function cmdKeys({ flags }) {
  return withRuntime(flags, async (runtime) => {
    const keyDir = path.join(runtime.config.dataDir, 'keys');
    const jwks = runtime.signer.jwks();
    if (flags.json) {
      printJson({ keyId: runtime.signer.keyId, keyDir, jwks });
      return 0;
    }
    out(`${bold('Key id')}     ${runtime.signer.keyId}`);
    out(`${bold('Key files')}  ${keyDir}`);
    out(`${bold('Directory')}  <server>/.well-known/http-message-signatures-directory`);
    out(`${bold('Signing')}    ${runtime.config.signing.enabled !== false ? green('enabled') : yellow('disabled')}`);
    out('');
    printJson(jwks);
    return 0;
  });
}

async function cmdStats({ flags }) {
  return withRuntime(flags, async (runtime) => {
    const entries = readAuditFile(runtime.config.dataDir);
    const byKind = {};
    const byRole = {};
    let blocked = 0;
    for (const e of entries) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      if (e.role) byRole[e.role] = (byRole[e.role] || 0) + 1;
      if (e.blocked) blocked++;
    }
    const stats = { index: runtime.index.stats(), auditLog: { total: entries.length, byKind, byRole, blocked }, dataDir: runtime.config.dataDir };
    if (flags.json) {
      printJson(stats);
      return 0;
    }
    const s = stats.index;
    heading('Index');
    out(`  ${s.docs} documents · ${s.passages} passages · ${s.terms} terms${s.lastUpdated ? dim(` · updated ${s.lastUpdated}`) : ''}`);
    for (const site of (s.sites || []).slice(0, 15)) out(`  ${String(site.docs).padStart(6)}  ${site.site}`);
    heading('Audit log');
    out(`  ${entries.length} entries · ${blocked} blocked`);
    out(`  by kind: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}`);
    out(`  by role: ${Object.entries(byRole).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}`);
    out(dim(`\nData directory: ${stats.dataDir}`));
    return 0;
  });
}

async function cmdAudit({ flags }) {
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig(dataDirOverride(flags));
  const limit = intFlag(flags, 'limit', { min: 1 }) ?? 30;
  const role = lastValue(flags.role);
  const kind = lastValue(flags.kind);
  const entries = readAuditFile(config.dataDir)
    .filter((e) => (!role || e.role === role) && (!kind || e.kind === kind))
    .slice(-limit)
    .reverse();
  if (flags.json) {
    printJson({ entries });
    return 0;
  }
  if (!entries.length) out(dim('No audit entries yet.'));
  for (const e of entries) {
    const time = dim(String(e.ts || '').replace('T', ' ').slice(0, 19));
    if (e.kind === 'fetch' || e.kind === 'robots') {
      const status = e.blocked ? magenta(`blocked:${e.blocked}`) : e.error ? red(`error`) : e.status >= 400 ? red(e.status) : green(e.status ?? '---');
      out(`${time}  ${String(e.kind).padEnd(6)} ${String(e.token || e.role || '').padEnd(11)} ${status}  ${e.url}${e.elapsedMs !== undefined ? dim(`  ${e.elapsedMs} ms`) : ''}${e.error ? red(`  ${truncate(e.error, 80)}`) : ''}`);
    } else if (e.kind === 'crawl') {
      out(`${time}  crawl  ${e.jobId || ''} ${e.event || ''} ${e.url || ''}${e.detail ? dim(`  ${truncate(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail), 80)}`) : ''}`);
    } else if (e.kind === 'agent') {
      out(`${time}  agent  ${e.mode || ''} ${e.model || ''} ${e.ok ? green('ok') : yellow('fallback')}${e.costUsd ? dim(`  $${Number(e.costUsd).toFixed(4)}`) : ''}`);
    } else {
      out(`${time}  ${String(e.kind).padEnd(6)} ${truncate(JSON.stringify(e), 140)}`);
    }
  }
  return 0;
}

async function cmdIndex({ args, flags }) {
  const [sub, ...rest] = args;
  if (!['list', 'clear', 'remove'].includes(sub)) throw new UsageError('usage: cairn index list|clear|remove <url>');
  return withRuntime(flags, async (runtime) => {
    const { index } = runtime;
    if (sub === 'list') {
      const res = index.list({ site: lastValue(flags.site), limit: intFlag(flags, 'limit', { min: 1 }) ?? 50 });
      if (flags.json) {
        printJson(res);
        return 0;
      }
      out(dim(`${res.total} document${res.total === 1 ? '' : 's'}`));
      for (const d of res.docs) out(`  ${cyan(d.url)}  ${truncate(d.title || '', 60)} ${dim(`${d.wordCount ?? '?'} words · ${d.role || ''} · ${d.fetchedAt || ''}`)}`);
      return 0;
    }
    if (sub === 'clear') {
      const before = index.stats().docs;
      index.clear();
      await index.save();
      out(`Removed ${before} document${before === 1 ? '' : 's'} from the index.`);
      return 0;
    }
    const target = rest[0];
    if (!target) throw new UsageError('usage: cairn index remove <url>');
    const { normalizeUrl } = await import('../src/util/url.js');
    const key = [target, normalizeUrl(target)].find((u) => u && index.has(u));
    if (!key) {
      out(yellow(`Not in index: ${target}`));
      return 1;
    }
    index.remove(key);
    await index.save();
    out(`Removed ${key}`);
    return 0;
  });
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function cmdDoctor({ flags }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}${major >= 20 ? '' : ' (Cairn needs Node 20 or newer)'}`);

  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig(dataDirOverride(flags));
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('Data directory', 'ok', `${config.dataDir} is writable`);
  } catch (err) {
    add('Data directory', 'fail', `${config.dataDir}: ${err.message}`);
  }

  const privKey = path.join(config.dataDir, 'keys', 'ed25519-private.pem');
  if (fs.existsSync(privKey)) {
    const mode = fs.statSync(privKey).mode & 0o777;
    add('Signing key', mode & 0o077 ? 'warn' : 'ok', `${privKey}${mode & 0o077 ? ` has mode ${mode.toString(8)}; run chmod 600` : ''}`);
  } else {
    add('Signing key', 'warn', `not created yet — generated automatically on first run (or run \`cairn keys\`)`);
  }

  try {
    const { claudeAvailable } = await import('../src/agent/claude.js');
    const c = await claudeAvailable(config);
    if (c.available) add('Claude CLI', 'ok', `${c.bin || config.agent.claudeBin} ${c.version || ''}`.trim());
    else add('Claude CLI', 'warn', `${config.agent.claudeBin} not usable (${c.error || 'unavailable'}); quick answers fall back to extractive, deep research is unavailable`);
  } catch (err) {
    add('Claude CLI', 'warn', `check failed: ${err.message}`);
  }

  const free = await portFree(config.port, config.host);
  add('Port', free ? 'ok' : 'warn', free ? `${config.host}:${config.port} is free` : `${config.host}:${config.port} is in use (Cairn may already be running; use --port)`);

  add('Web UI', fs.existsSync(path.join(ROOT, 'web', 'index.html')) ? 'ok' : 'warn', path.join(ROOT, 'web'));
  add('Assistant UI', fs.existsSync(path.join(ROOT, 'web', 'bubble.html')) ? 'ok' : 'warn', path.join(ROOT, 'web', 'bubble.html'));
  add('Docs', fs.existsSync(path.join(ROOT, 'docs', 'index.html')) ? 'ok' : 'warn', path.join(ROOT, 'docs'));
  const appBundle = path.join(ROOT, 'desktop', 'build', 'Cairn.app');
  const installedApp = installedDesktopApp();
  if (process.platform !== 'darwin') add('Desktop app', 'warn', 'the floating bubble is macOS only');
  else if (installedApp) add('Desktop app', 'ok', `${installedApp} (start it from the Dock, Spotlight or Apps / Launchpad; update with \`node bin/cairn.js desktop --install\`)`);
  else if (fs.existsSync(path.join(appBundle, 'Contents', 'MacOS', 'Cairn'))) add('Desktop app', 'ok', `${appBundle} (not installed — \`node bin/cairn.js desktop --install\` puts it in /Applications)`);
  else add('Desktop app', 'warn', `${appBundle} not built yet — run \`node bin/cairn.js desktop --install\` (builds, installs and launches it)`);

  const failed = checks.some((c) => c.status === 'fail');
  if (flags.json) {
    printJson({ ok: !failed, checks });
  } else {
    const mark = { ok: green('✔ ok  '), warn: yellow('! warn'), fail: red('✖ fail') };
    for (const c of checks) out(`${mark[c.status]}  ${bold(c.name.padEnd(15))} ${c.detail}`);
    out(failed ? red('\nSome checks failed.') : green('\nCairn is ready.'));
  }
  return failed ? 1 : 0;
}

async function loadFixture() {
  try {
    return await import('../fixtures/site-server.js');
  } catch (err) {
    throw new Error(`The demo site (fixtures/site-server.js) could not be loaded: ${err.message}`);
  }
}

async function cmdFixture({ flags }) {
  const { startFixtureSite } = await loadFixture();
  const port = intFlag(flags, 'port', { min: 0, max: 65535 }) ?? 8788;
  const site = await startFixtureSite({ port, host: lastValue(flags.host) || '127.0.0.1' });
  out(`${bold('Northwind Trails')} demo site on ${cyan(site.url)}`);
  out(dim(`Try: node bin/cairn.js crawl ${site.url}/`));
  out(dim('Press Ctrl-C to stop.'));
  await waitForSignal();
  await site.close();
  return 0;
}

async function cmdDemo({ flags }) {
  const { startFixtureSite } = await loadFixture();
  const { robotsDecisions } = await import('../src/server/api.js');
  const explicitDir = lastValue(flags['data-dir']);
  const dataDir = explicitDir ? path.resolve(explicitDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-demo-'));
  const site = await startFixtureSite({ port: 0 });
  const { createRuntime } = await import('../src/runtime.js');
  const runtime = await createRuntime({ dataDir, politeness: { minDelayMs: 200 } });
  if (flags['no-claude']) {
    // Point at a binary that cannot exist so answering takes the extractive path.
    runtime.config.agent.claudeBin = path.join(dataDir, 'no-claude-for-demo');
  }
  runtime.config.agent.timeoutMs = Math.min(runtime.config.agent.timeoutMs, 120000);

  try {
    out(`${bold('1. Demo site')}  Northwind Trails is running at ${cyan(site.url)}`);
    out(dim(`   Data directory: ${dataDir}`));

    out(`\n${bold('2. Crawl')}  as CairnSearch, 200 ms between requests per host`);
    const status = await runCrawl(runtime, { seeds: [`${site.url}/`], role: 'search', maxPages: 60, maxDepth: 5 });
    out('');
    printCounts(status);

    out(`\n${bold('3. robots.txt')}  decisions for ${site.url}/private/secret.html`);
    const rd = await robotsDecisions(runtime, { url: `${site.url}/private/secret.html` });
    for (const d of rd.decisions) out(`   ${d.token.padEnd(12)} ${allowedLabel(d.allowed)}  ${ruleText(d.rule)}`);

    const query = 'ridgeback backpack weight';
    out(`\n${bold('4. Search')}  "${query}"`);
    printSearch(runtime.index.search(query, { limit: 3 }));

    const question = 'How much does the Ridgeback 45 weigh and what is the return window?';
    out(`\n${bold('5. Ask')}  ${question}`);
    const { answerQuestion } = await import('../src/agent/answer.js');
    const result = await answerQuestion(question, { runtime, onEvent: askEventPrinter() });
    printAnswer(result);

    // Audit ourselves: re-check every path the site actually served against CairnSearch's robots rules.
    const paths = [...new Set(site.requests.map((r) => r.path))];
    let violations = 0;
    for (const p of paths) {
      if (p === '/robots.txt') continue;
      const check = await runtime.fetcher.checkRobots(`${site.url}${p}`, 'search');
      if (!check.allowed) violations++;
    }
    out(`\n${bold('Done.')} The fixture site received ${site.requests.length} requests for ${paths.length} paths; ` +
      (violations ? red(`${violations} were disallowed by robots.txt!`) : green('none were disallowed by robots.txt.')));
    out(dim('Run `node bin/cairn.js serve` and open /bot to see what site owners see.'));
    return 0;
  } finally {
    await runtime.close();
    await site.close();
    if (!explicitDir && !flags.keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else out(dim(`Data kept in ${dataDir}`));
  }
}

// ---------------------------------------------------------------------------
// Assistant commands: thin clients of the running server's /api/assistant/*.
// ---------------------------------------------------------------------------

const SERVER_HINT = "Start it with 'node bin/cairn.js serve' or 'node bin/cairn.js desktop'.";

class ServerUnavailable extends Error {}

async function serverBase(flags) {
  const port = intFlag(flags, 'port', { min: 1, max: 65535 });
  if (port !== undefined) return `http://127.0.0.1:${port}`;
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig(dataDirOverride(flags));
  return `http://127.0.0.1:${config.port}`;
}

// JSON request against the running server. Rejects with ServerUnavailable when
// nothing is listening, or with the API's own error message.
async function apiCall(base, method, urlPath, body, { timeoutMs = 30000 } = {}) {
  const init = { method, headers: { Accept: 'application/json', 'X-Cairn-Client': 'cli' }, signal: AbortSignal.timeout(timeoutMs) };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(`${base}${urlPath}`, init);
  } catch (err) {
    throw new ServerUnavailable(`Cairn is not running at ${base} (${err.cause?.code || err.name || err.message}).`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    // Unknown ids answer "Unknown …"; a bare route 404 means an older server without the assistant.
    if (res.status === 404 && /^Not found: \/api\/assistant/.test(data?.error || '')) {
      throw new ServerUnavailable(`The server at ${base} has no assistant API (an older Cairn?). Restart it.`);
    }
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Wraps an assistant command: resolves the server URL and turns "not running"
// into a clear message (exit 1).
function assistantCommand(fn) {
  return async (ctx) => {
    const base = await serverBase(ctx.flags);
    try {
      return await fn({ ...ctx, base, call: (method, p, body, opts) => apiCall(base, method, p, body, opts) });
    } catch (err) {
      if (!(err instanceof ServerUnavailable)) throw err;
      info(red(err.message));
      info(SERVER_HINT);
      return 1;
    }
  };
}

function localTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function recurrenceText(r) {
  if (!r || !r.every) return 'once';
  const n = Number(r.interval) > 1 ? `${r.interval} ${r.every}s` : r.every;
  const days = Array.isArray(r.days) && r.days.length ? ` on ${r.days.join(',')}` : '';
  return `every ${n}${days}${r.at ? ` at ${r.at}` : ''}`;
}

function printTask(t) {
  const status = t.status === 'active' ? green(t.status) : dim(t.status || '?');
  out(`  ${bold(truncate(t.title, 70))}  ${dim(`[${t.kind}]`)}`);
  out(`    ${dim('id')} ${t.id}  ${dim('next')} ${localTime(t.nextRunAt)}  ${dim('repeat')} ${recurrenceText(t.recurrence)}  ${status}`);
}

function approvalHint(id) {
  return `approve: ${cyan(`node bin/cairn.js approvals approve ${id}`)}   deny: ${cyan(`node bin/cairn.js approvals deny ${id}`)}`;
}

// Minimal SSE reader over fetch(): calls onEvent(type, data) per event until
// the stream ends or `signal` aborts.
async function readSse(url, { onEvent, signal }) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream', 'X-Cairn-Client': 'cli' }, signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = JSON.parse(await res.text()).error || msg;
    } catch {
      // keep the status text
    }
    throw new Error(msg);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
      let type = 'message';
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let parsed;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        parsed = data.join('\n');
      }
      if (onEvent(type, parsed) === false) return;
    }
  }
}

async function followRun(base, runId, { json = false } = {}) {
  const controller = new AbortController();
  let detached = false;
  const onSigint = () => {
    detached = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  let printedText = false;
  let final = { state: 'unknown' };
  const log = json ? info : out;
  try {
    await readSse(`${base}/api/assistant/runs/${encodeURIComponent(runId)}/events`, {
      signal: controller.signal,
      onEvent: (type, ev) => {
        if (type === 'text' && ev.text) {
          log(ev.text);
          printedText = true;
        } else if (type === 'status' && ev.message) info(dim(`· ${ev.message}`));
        else if (type === 'tool') info(`${blue('→')} ${ev.summary || ev.name} ${ev.summary ? '' : dim(truncate(JSON.stringify(ev.input ?? {}), 120))}`.trimEnd());
        else if (type === 'tool_result') info(`${ev.isError ? red('←') : green('←')} ${dim(truncate(String(ev.summary ?? '').replace(/\s+/g, ' '), 140))}`);
        else if (type === 'approval' && ev.approval) {
          const a = ev.approval;
          info(`\n${yellow(bold('Approval needed'))} ${a.summary || a.toolName}`);
          if (a.input !== undefined) info(dim(`  input: ${truncate(JSON.stringify(a.input), 200)}`));
          info(`  ${approvalHint(a.id)}`);
          info(dim('  (or use the Assistant window / desktop bubble)'));
        } else if (type === 'approval_resolved') info(ev.allow ? green('✔ approved') : red(`✖ denied${ev.message ? ` — ${ev.message}` : ''}`));
        else if (type === 'result') {
          final = { ...final, text: ev.text, costUsd: ev.costUsd };
          if (!printedText && ev.text) log(ev.text);
        } else if (type === 'error') {
          final = { ...final, error: ev.message };
          info(red(`error: ${ev.message}`));
        } else if (type === 'done') {
          final = { ...final, state: ev.state };
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    if (!detached) throw err;
  } finally {
    process.off('SIGINT', onSigint);
  }
  if (detached) final.state = 'detached';
  return final;
}

async function cmdChatImpl({ args, flags, base, call }) {
  const message = args.join(' ').trim();
  if (!message) throw new UsageError('chat needs a message, e.g. cairn chat "find me a quiet 4-person tent under $200"');
  const conversationId = lastValue(flags.conversation);
  const started = await call('POST', '/api/assistant/chat', { message, ...(conversationId ? { conversationId } : {}) });
  const { runId } = started;
  if (!flags.json) info(dim(`· run ${runId} · conversation ${started.conversationId}`));
  if (flags['no-follow']) {
    if (flags.json) printJson(started);
    else out(`Started run ${runId} in the background. Follow it in the assistant: ${base}/assistant`);
    return 0;
  }
  const final = await followRun(base, runId, { json: flags.json });
  if (flags.json) {
    printJson({ ...started, ...final });
  } else if (final.state === 'detached') {
    info(yellow('\nDetached — the run keeps going in the background; you will get a notification when it finishes.'));
  } else {
    const bits = [final.state === 'done' ? green('done') : final.state === 'cancelled' ? yellow('cancelled') : red(final.state)];
    if (final.costUsd) bits.push(`$${Number(final.costUsd).toFixed(4)}`);
    info(dim(`\n${bits.join(' · ')}`));
  }
  if (!flags.json) info(dim(`Continue: node bin/cairn.js chat --conversation ${started.conversationId} "…"`));
  return final.state === 'done' || final.state === 'detached' ? 0 : 1;
}

async function cmdRemindImpl({ args, flags, call }) {
  const text = args.join(' ').trim();
  if (!text) throw new UsageError('remind needs text, e.g. cairn remind "in 20 minutes take the laundry out"');
  const { task } = await call('POST', '/api/assistant/tasks', { text });
  if (flags.json) {
    printJson(task);
    return 0;
  }
  out(`${green('✔')} Scheduled ${bold(task.title)} for ${localTime(task.nextRunAt)} ${dim(`(${recurrenceText(task.recurrence)}, id ${task.id})`)}`);
  return 0;
}

async function cmdTasksImpl({ args, flags, call }) {
  const [sub = 'list', id] = args;
  if (sub === 'list') {
    const { tasks } = await call('GET', `/api/assistant/tasks${flags.all ? '?includeDone=true' : ''}`);
    if (flags.json) {
      printJson({ tasks });
      return 0;
    }
    if (!tasks.length) out(dim('No upcoming tasks. Add one with: node bin/cairn.js remind "tomorrow at 9am water the plants"'));
    for (const t of tasks) printTask(t);
    return 0;
  }
  if (sub !== 'cancel' && sub !== 'run') throw new UsageError('usage: cairn tasks [list [--all] | cancel <id> | run <id>]');
  if (!id) throw new UsageError(`usage: cairn tasks ${sub} <id>`);
  const p = `/api/assistant/tasks/${encodeURIComponent(id)}`;
  const res = sub === 'cancel' ? await call('DELETE', p, {}) : await call('POST', `${p}/run`, {}, { timeoutMs: 600000 });
  if (flags.json) printJson(res);
  else out(sub === 'cancel' ? `${green('✔')} Cancelled ${res.task?.title || id}` : `${green('✔')} Ran ${res.task?.title || id} ${dim('(results arrive as a notification)')}`);
  return 0;
}

async function cmdApprovalsImpl({ args, flags, call }) {
  const [sub = 'list', id] = args;
  if (sub === 'list') {
    const { pending } = await call('GET', '/api/assistant/approvals');
    if (flags.json) {
      printJson({ pending });
      return 0;
    }
    if (!pending.length) out(dim('Nothing is waiting for your approval.'));
    for (const a of pending) {
      out(`  ${bold(a.summary || a.toolName)}  ${dim(`[${a.toolName}]`)}`);
      out(`    ${dim('id')} ${a.id}  ${dim('since')} ${localTime(a.createdAt)}${a.runId ? dim(`  run ${a.runId}`) : ''}`);
      if (a.input !== undefined) out(dim(`    input: ${truncate(JSON.stringify(a.input), 200)}`));
      out(`    ${approvalHint(a.id)}`);
    }
    return 0;
  }
  if (sub !== 'approve' && sub !== 'deny') throw new UsageError('usage: cairn approvals [list | approve <id> [--always] | deny <id> [--message M]]');
  if (!id) throw new UsageError(`usage: cairn approvals ${sub} <id>`);
  const body = sub === 'approve' ? { allow: true, ...(flags.always ? { always: true } : {}) } : { allow: false, message: lastValue(flags.message) || 'Denied from the command line' };
  const res = await call('POST', `/api/assistant/approvals/${encodeURIComponent(id)}`, body);
  if (flags.json) printJson(res);
  else out(sub === 'approve' ? `${green('✔')} Approved ${id}${res.alwaysAllowed ? dim(` (always allowing ${res.alwaysAllowed} in this conversation)`) : ''}` : `${red('✖')} Denied ${id}`);
  return 0;
}

async function cmdShoppingImpl({ flags, call }) {
  const { items } = await call('GET', `/api/assistant/shopping${flags.all ? '' : '?includeDone=false'}`);
  if (flags.json) {
    printJson({ items });
    return 0;
  }
  if (!items.length) out(dim('The shopping list is empty. Try: node bin/cairn.js chat "shop for a 2-person tent under $150"'));
  for (const i of items) {
    const price = i.price === null || i.price === undefined || i.price === '' ? '' : ` ${green(typeof i.price === 'number' ? `$${i.price.toFixed(2)}` : i.price)}`;
    out(`  ${i.done ? dim('✔') : '•'} ${bold(i.item)}${i.quantity > 1 ? dim(` ×${i.quantity}`) : ''}${price}${i.store ? dim(` · ${i.store}`) : ''}`);
    if (i.url) out(`    ${cyan(i.url)}`);
    if (i.notes) out(dim(`    ${truncate(i.notes, 160)}`));
  }
  out(dim('\nCairn never pays for anything — checkout is always yours.'));
  return 0;
}

async function cmdAssistantImpl({ base, call }) {
  await call('GET', '/api/assistant/health', undefined, { timeoutMs: 5000 });
  const url = `${base}/assistant`;
  out(`Opening ${cyan(url)}`);
  openInBrowser(url);
  return 0;
}

/** The installed copy of the desktop app (what desktop/install.sh creates), or null. */
function installedDesktopApp() {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const app = path.join(dir, 'Cairn.app');
    if (fs.existsSync(path.join(app, 'Contents', 'MacOS', 'Cairn'))) return app;
  }
  return null;
}

async function cmdDesktop({ flags }) {
  if (process.platform !== 'darwin') throw new Error('The desktop bubble is a macOS app; use `node bin/cairn.js assistant` for the browser version.');
  // --install → desktop/install.sh (build if needed, copy to /Applications, register, add to the Dock, launch);
  // otherwise desktop/run.sh launches the installed app if there is one, else the build.
  const script = path.join(ROOT, 'desktop', flags.install ? 'install.sh' : 'run.sh');
  if (!fs.existsSync(script)) throw new Error(`${script} is missing`);
  if (flags.install && (flags.quit || flags.restart)) throw new UsageError('desktop --install cannot be combined with --quit or --restart (it quits and relaunches Cairn itself)');
  if (flags['no-launch'] && !flags.install) throw new UsageError('--no-launch only applies to desktop --install');
  if (flags['no-dock'] && !flags.install) throw new UsageError('--no-dock only applies to desktop --install');
  const allowed = flags.install ? ['rebuild', 'no-launch', 'no-dock'] : ['rebuild', 'restart', 'quit'];
  const extra = allowed.filter((f) => flags[f]).map((f) => `--${f}`);
  const r = spawnSync('bash', [script, ...extra], { stdio: 'inherit', cwd: ROOT });
  if (r.error) throw new Error(`Could not run ${script}: ${r.error.message}`);
  return r.status ?? 1;
}

const cmdChat = assistantCommand(cmdChatImpl);
const cmdRemind = assistantCommand(cmdRemindImpl);
const cmdTasks = assistantCommand(cmdTasksImpl);
const cmdApprovals = assistantCommand(cmdApprovalsImpl);
const cmdShopping = assistantCommand(cmdShoppingImpl);
const cmdAssistant = assistantCommand(cmdAssistantImpl);

const COMMANDS = {
  serve: cmdServe,
  crawl: cmdCrawl,
  search: cmdSearch,
  ask: cmdAsk,
  fetch: cmdFetch,
  robots: cmdRobots,
  keys: cmdKeys,
  stats: cmdStats,
  audit: cmdAudit,
  index: cmdIndex,
  doctor: cmdDoctor,
  fixture: cmdFixture,
  demo: cmdDemo,
  chat: cmdChat,
  remind: cmdRemind,
  tasks: cmdTasks,
  approvals: cmdApprovals,
  shopping: cmdShopping,
  assistant: cmdAssistant,
  desktop: cmdDesktop,
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    colorOn = decideColor({});
    info(red(`error: ${err.message}`));
    info(dim('Run `cairn help` for usage.'));
    return 2;
  }
  const { positionals, flags } = parsed;
  colorOn = decideColor(flags);
  const [cmd = 'help', ...args] = positionals;

  if (flags.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    out(`cairn ${pkg.version}`);
    return 0;
  }
  if (flags.help || cmd === 'help') {
    out(HELP);
    return 0;
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    info(red(`error: unknown command "${cmd}"`));
    info(HELP);
    return 2;
  }
  try {
    return (await handler({ args, flags })) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      info(red(`error: ${err.message}`));
      info(dim('Run `cairn help` for usage.'));
      return 2;
    }
    info(red(`error: ${err.message}`));
    if (process.env.CAIRN_DEBUG) info(err.stack);
    return 1;
  }
}

function exitAfterFlush(code) {
  // Wait for piped stdout/stderr to drain before exiting (writes are async on macOS pipes).
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const invokedDirectly = isMainModule();
if (invokedDirectly) {
  main(process.argv.slice(2)).then(exitAfterFlush, (err) => {
    process.stderr.write(`fatal: ${err?.stack || err}\n`);
    exitAfterFlush(1);
  });
}
