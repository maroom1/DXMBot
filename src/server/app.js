// Cairn HTTP server: security guards, static files (/web, /docs), the public
// site-owner endpoints (/bot, IP range JSON, Web Bot Auth key directory) and
// the JSON API (api.js).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from '../config.js';
import { ROLES } from '../identity.js';
import { HttpError, JWKS_PATH, handleApi, ipRanges, sendJson } from './api.js';
import { renderBotPage } from './botpage.js';
import { assistantFor, closeAssistant } from '../assistant/routes.js';

export const WEB_ROOT = path.join(PROJECT_ROOT, 'web');
export const DOCS_ROOT = path.join(PROJECT_ROOT, 'docs');
export const BODY_LIMIT = 1024 * 1024;
// Once a body is known to be too large we keep draining (so the client can read
// the 413) but give up on clients that keep sending far beyond the limit.
const DRAIN_LIMIT = 16 * BODY_LIMIT;

export const HTML_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
// Avatar pages (web/avatars/*) may be framed by our own pages (the gallery, the bubble).
const FRAMEABLE_PREFIX = '/web/avatars/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

// Static docs pages carry small inline bootstrap scripts (Mermaid init). Rather
// than weakening the CSP with 'unsafe-inline', allow exactly those scripts by hash.
export function cspForHtml(html) {
  const hashes = new Set();
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    if (!m[1]) continue;
    hashes.add(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes.size ? `${HTML_CSP}; script-src 'self' ${[...hashes].join(' ')}` : HTML_CSP;
}

function sendHtml(res, status, html, extraHeaders = {}, { frameable = false } = {}) {
  let csp = cspForHtml(html);
  if (frameable) {
    csp = csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(301, { Location: location, 'Content-Length': 0 });
  res.end();
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        if (size > DRAIN_LIMIT) {
          done(reject, new HttpError(413, 'Request body exceeds 1 MB'));
          req.destroy();
        }
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) return done(reject, new HttpError(413, 'Request body exceeds 1 MB'));
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done(resolve, {});
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return done(reject, new HttpError(400, 'Invalid JSON body'));
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return done(reject, new HttpError(400, 'JSON body must be an object'));
      }
      done(resolve, value);
    });
    req.on('error', (err) => done(reject, new HttpError(400, `Request error: ${err.message}`)));
  });
}

const realRoots = new Map();
async function realRoot(root) {
  if (!realRoots.has(root)) realRoots.set(root, await fsp.realpath(root).catch(() => root));
  return realRoots.get(root);
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

// Serve `relPath` (still URL-encoded, relative to the mount point) from `root`.
// Returns false when nothing suitable exists so the caller can 404.
async function serveStatic(req, res, root, relPath, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    throw new HttpError(400, 'Malformed URL path');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'Malformed URL path');
  const segments = decoded.split('/').filter(Boolean);
  // No dotfiles and no parent-directory segments, before or after normalisation.
  if (segments.some((s) => s.startsWith('.'))) return false;
  let file = path.join(root, ...segments);
  if (!within(root, file)) return false;

  let stat = await fsp.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    if (!urlPath.endsWith('/')) {
      redirect(res, `${urlPath}/`);
      return true;
    }
    file = path.join(file, 'index.html');
    stat = await fsp.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) return false;

  // Symlinks must not lead outside the served tree.
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || !within(await realRoot(root), real)) return false;

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) {
    sendHtml(res, 200, await fsp.readFile(file, 'utf8'), {}, { frameable: urlPath.startsWith(FRAMEABLE_PREFIX) });
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

function fallbackHome() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cairn</title>
<link rel="stylesheet" href="/docs/assets/docs.css"></head><body><main>
<h1>Cairn is running</h1><p class="lead">The web UI (web/index.html) is not installed. The API is available under <code>/api/</code>.</p>
<ul><li><a href="/bot">Information for site owners (/bot)</a></li><li><a href="/docs/">Documentation</a></li><li><a href="/api/health">/api/health</a></li></ul>
</main></body></html>`;
}

const IP_FILES = new Map(Object.values(ROLES).map((r) => [`/bot/${r.ipFile}`, r]));

// Cairn's own bots (a prompt-injected research agent doing fetch_page on
// http://127.0.0.1:<port>/api/..., or a crawl of it) must never drive the API.
const OWN_BOT_UA = new RegExp(`\\b(?:${Object.values(ROLES).map((r) => r.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/\\d`);
// GET routes with side effects (spend Claude budget, start live fetches).
const SIDE_EFFECT_GETS = new Set(['/api/ask/stream']);
const UI_COOKIE = 'cairn_ui';

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function handlePublic(ctx) {
  const { req, res, url, runtime } = ctx;
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    if (await serveStatic(req, res, WEB_ROOT, 'index.html', '/index.html')) return true;
    sendHtml(res, 200, fallbackHome());
    return true;
  }
  // Full-page desktop assistant (the same UI the floating bubble loads). Its
  // relative ./bubble.css / ./bubble.js resolve to the top-level asset route.
  if (p === '/assistant') {
    if (await serveStatic(req, res, WEB_ROOT, 'bubble.html', '/assistant')) return true;
    return false;
  }
  if (p === '/assistant/' || p === '/assistant.html') {
    redirect(res, '/assistant');
    return true;
  }
  if (p === '/bot' || p === '/bot/') {
    sendHtml(res, 200, renderBotPage(runtime));
    return true;
  }
  if (IP_FILES.has(p)) {
    sendJson(res, 200, ipRanges(runtime), { 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  if (p === JWKS_PATH) {
    const body = JSON.stringify(runtime.signer.jwks(), null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/http-message-signatures-directory+json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(body);
    return true;
  }
  if (p === '/favicon.ico') {
    // Pages declare their own (data:) icons; answer the browser's implicit probe quietly.
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return true;
  }
  if (p === '/web' || p === '/docs') {
    redirect(res, `${p}/`);
    return true;
  }
  if (p.startsWith('/web/')) return serveStatic(req, res, WEB_ROOT, p.slice('/web/'.length), p);
  if (p.startsWith('/docs/')) return serveStatic(req, res, DOCS_ROOT, p.slice('/docs/'.length), p);
  // Convenience: the UI served at "/" may reference top-level assets relatively (app.js, styles.css).
  if (/^\/[\w-]+\.(?:js|css|svg|png|ico|webp)$/.test(p)) return serveStatic(req, res, WEB_ROOT, p.slice(1), p);
  return false;
}

export function allowedHostsFor(host, port, config) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (host && !['0.0.0.0', '::'].includes(host)) hosts.add(`${host.includes(':') ? `[${host}]` : host}:${port}`.toLowerCase());
  if (config.publicBaseUrlExplicit && config.publicBaseUrl) {
    try {
      hosts.add(new URL(config.publicBaseUrl).host.toLowerCase());
    } catch {
      // An unparsable public URL simply adds nothing.
    }
  }
  return hosts;
}

// Origins a same-origin browser request may carry: every bound host over http,
// plus the explicit public URL's own origin (e.g. https behind a TLS proxy).
export function allowedOriginsFor(hosts, config) {
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  if (config.publicBaseUrlExplicit && config.publicBaseUrl) {
    try {
      origins.add(new URL(config.publicBaseUrl).origin.toLowerCase());
    } catch {
      // An unparsable public URL simply adds nothing.
    }
  }
  return origins;
}

export function createRequestHandler(runtime, state) {
  return async function handle(req, res) {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      // DNS-rebinding guard: only answer to the names this server is actually bound as.
      const host = String(req.headers.host || '').toLowerCase();
      if (!state.allowedHosts.has(host)) {
        return sendJson(res, 421, { error: 'Misdirected request: unexpected Host header' });
      }

      const method = String(req.method || 'GET').toUpperCase();
      let url;
      try {
        url = new URL(req.url || '/', `http://${host}`);
      } catch {
        throw new HttpError(400, 'Malformed request URL');
      }

      let body = null;
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      const originOk = (o) => o === `http://${host}` || Boolean(state.allowedOrigins?.has(String(o).toLowerCase()));
      if (isApi && OWN_BOT_UA.test(String(req.headers['user-agent'] || ''))) {
        req.resume();
        return sendJson(res, 403, { error: "Cairn's own bots may not call its API" });
      }
      if (isApi && (method === 'GET' || method === 'HEAD')) {
        // Some API GETs have side effects (GET /api/ask/stream spends Claude
        // budget and deep mode starts crawls). A foreign page can trigger a GET
        // without CORS (img, EventSource), so refuse cross-site and same-site
        // (another localhost port) browser requests. CLI/MCP clients send
        // neither header and are unaffected.
        const origin = req.headers.origin;
        const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        if ((origin !== undefined && !originOk(origin)) || fetchSite === 'cross-site' || fetchSite === 'same-site') {
          return sendJson(res, 403, { error: 'Cross-origin request rejected' });
        }
        // Browsers without Fetch Metadata send neither header on an <img> or
        // no-cors GET, so side-effecting GETs also need positive proof: a
        // same-origin/user-initiated Sec-Fetch-Site, the UI's SameSite=Strict
        // cookie, or a custom header (which a cross-site page cannot add).
        if (SIDE_EFFECT_GETS.has(url.pathname.replace(/\/+$/, ''))) {
          const proven =
            fetchSite === 'same-origin' ||
            fetchSite === 'none' ||
            req.headers['x-cairn-client'] !== undefined ||
            Boolean(state.uiToken && cookieValue(req.headers.cookie, UI_COOKIE) === state.uiToken);
          if (!proven) {
            return sendJson(res, 403, { error: 'Same-origin proof required: use the Cairn UI or send an X-Cairn-Client header' });
          }
        }
      }
      if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        // CSRF guard: browsers always send Origin on cross-origin writes; it must be us.
        const origin = req.headers.origin;
        if (origin !== undefined && !originOk(origin)) {
          req.resume();
          return sendJson(res, 403, { error: 'Cross-origin request rejected' }, { Connection: 'close' });
        }
        if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
          req.resume();
          return sendJson(res, 403, { error: 'Cross-site request rejected' }, { Connection: 'close' });
        }
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          req.resume();
          return sendJson(res, 415, { error: 'Content-Type must be application/json' }, { Connection: 'close' });
        }
        body = await readJsonBody(req);
      }

      const ctx = { req, res, url, method: method === 'HEAD' ? 'GET' : method, runtime, state, body, status: 200, params: {} };
      if (isApi) {
        if (await handleApi(ctx)) return;
        return sendJson(res, 404, { error: `Not found: ${url.pathname}` });
      }
      if (ctx.method !== 'GET') return sendJson(res, 405, { error: `Method ${method} not allowed` }, { Allow: 'GET, HEAD' });
      if (state.uiToken) res.setHeader('Set-Cookie', `${UI_COOKIE}=${state.uiToken}; Path=/; HttpOnly; SameSite=Strict`);
      if (await handlePublic(ctx)) return;
      return sendJson(res, 404, { error: `Not found: ${url.pathname}` });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
      // Unexpected failures (fs/system errors) carry internal paths: log them
      // with an id and return only the id.
      const internal = !(err instanceof HttpError) && status >= 500;
      const errorId = internal ? crypto.randomBytes(6).toString('hex') : null;
      if (status >= 500) console.error(`[cairn] request failed${errorId ? ` (${errorId})` : ''}:`, req.method, req.url, err);
      if (res.headersSent) {
        res.end();
        return;
      }
      const payload = internal ? { error: 'Internal server error', id: errorId } : { error: err.message || 'Internal server error' };
      sendJson(res, status, payload, status === 413 ? { Connection: 'close' } : {});
    }
  };
}

// `assistant: false` skips the desktop assistant (scheduler, background runs):
// the CLI's short-lived in-process servers (ask --deep, demo) use that.
export async function startServer({ runtime, port, host, assistant = true } = {}) {
  if (!runtime) throw new Error('startServer requires a runtime (see createRuntime)');
  const { config } = runtime;
  const bindHost = host ?? config.host ?? '127.0.0.1';
  const bindPort = port ?? config.port;

  const state = { url: null, port: null, allowedHosts: new Set(), allowedOrigins: new Set(), sse: new Set(), uiToken: crypto.randomBytes(16).toString('hex'), assistant: assistant !== false };
  const server = http.createServer(createRequestHandler(runtime, state));
  // Long-running answers (deep research) stream or block for minutes; don't time them out.
  server.requestTimeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPort, bindHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const shownHost = ['0.0.0.0', '::'].includes(bindHost) ? '127.0.0.1' : bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  state.port = actualPort;
  state.url = `http://${shownHost}:${actualPort}`;
  state.allowedHosts = allowedHostsFor(bindHost, actualPort, config);
  state.allowedOrigins = allowedOriginsFor(state.allowedHosts, config);
  if (!config.publicBaseUrlExplicit) config.publicBaseUrl = state.url;

  // Start the assistant only once publicBaseUrl is known (its MCP tools call back into this server).
  const assistantInstance = assistant ? assistantFor(runtime) : null;

  let closing = null;
  return {
    server,
    url: state.url,
    port: actualPort,
    runtime,
    assistant: assistantInstance,
    close() {
      closing ??= new Promise((resolve) => {
        // Stop the scheduler / background runs and close assistant SSE streams first.
        const stopAssistant = state.assistant ? closeAssistant(runtime).catch((err) => console.error('[cairn assistant] stop failed:', err)) : Promise.resolve();
        stopAssistant.then(() => {
          for (const client of [...state.sse]) client.close();
          server.close(() => resolve());
          server.closeIdleConnections?.();
          // Give in-flight responses a moment, then drop whatever is left.
          setTimeout(() => server.closeAllConnections?.(), 1000).unref();
        });
      });
      return closing;
    },
  };
}
