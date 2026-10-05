// The desktop assistant mounted in the real Cairn server (src/server/app.js +
// api.js): /api/assistant/* through the engine's guards, a chat run driven by
// the fake Claude CLI, the /assistant page, avatar static files, the CLI's
// assistant commands, and a clean shutdown (scheduler stopped, process exits).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.CAIRN_MAC_DRYRUN = '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cairn.js');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude-assistant.js');

const { createRuntime } = await import('../src/runtime.js');
const { startServer } = await import('../src/server/app.js');

let dataDir;
let runtime;
let srv;
let base;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-server-assistant-'));
  runtime = await createRuntime({ dataDir });
  runtime.config.agent.claudeBin = FAKE_CLAUDE;
  srv = await startServer({ runtime, port: 0 });
  base = srv.url;
});

after(async () => {
  await srv?.close();
  await runtime?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(method, p, body, headers = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

// Collect a run's SSE events until `done` (or timeout).
async function runEvents(runId, timeoutMs = 15000) {
  const res = await fetch(`${base}/api/assistant/runs/${runId}/events`, { signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const type = /^event: (.*)$/m.exec(frame)?.[1];
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (type && data) events.push({ type, data: JSON.parse(data) });
      if (type === 'done') return events;
    }
  }
  return events;
}

function cli(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1', CAIRN_HOME: dataDir } }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

test('assistant health through the real server', async () => {
  assert.ok(srv.assistant, 'startServer exposes the assistant');
  const r = await api('GET', '/api/assistant/health');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.claude.available, true);
  assert.equal(r.json.scheduler.running, true, 'scheduler started with the server');
  assert.equal(r.json.pendingApprovals, 0);
  // Engine guards still apply in front of the assistant.
  const evil = await api('GET', '/api/assistant/health', undefined, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const badType = await api('POST', '/api/assistant/chat', JSON.stringify({ message: 'hi' }), { 'Content-Type': 'text/plain' });
  assert.equal(badType.status, 415);
  const unknown = await api('GET', '/api/assistant/nope');
  assert.equal(unknown.status, 404);
  // Engine routes keep working next to the assistant.
  const engine = await api('GET', '/api/health');
  assert.equal(engine.status, 200);
});

test('chat starts a background run that completes (body parsed by app.js)', async () => {
  const r = await api('POST', '/api/assistant/chat', { message: 'ping from the server test' });
  assert.equal(r.status, 202, r.text);
  assert.ok(r.json.runId);
  assert.ok(r.json.conversationId);
  const events = await runEvents(r.json.runId);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('text'), `text event in ${types.join(',')}`);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).data.state, 'done');
  const text = events.filter((e) => e.type === 'text').map((e) => e.data.text).join('');
  assert.match(text, /ping from the server test/);
  const runs = await api('GET', '/api/assistant/runs');
  assert.ok(runs.json.runs.some((x) => x.runId === r.json.runId && x.state === 'done'));
});

test('GET /assistant serves the bubble UI full-page with the HTML CSP', async () => {
  const r = await api('GET', '/assistant');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.text, fs.readFileSync(path.join(ROOT, 'web', 'bubble.html'), 'utf8'));
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // Its relative ./bubble.css and ./bubble.js resolve to top-level assets.
  const css = await api('GET', '/bubble.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await api('GET', '/bubble.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  const slash = await fetch(`${base}/assistant/`, { redirect: 'manual' });
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get('location'), '/assistant');
  await slash.text();
  const post = await api('POST', '/assistant', {});
  assert.equal(post.status, 405);
});

test('avatar files under /web/avatars/ are served with the right content types', async (t) => {
  const dir = path.join(ROOT, 'web', 'avatars');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(html|json)$/.test(f) && !f.startsWith('.')) : [];
  if (!files.length) {
    t.skip('web/avatars has no html/json files');
    return;
  }
  for (const f of files) {
    const r = await api('GET', `/web/avatars/${f}`);
    assert.equal(r.status, 200, f);
    if (f.endsWith('.json')) {
      assert.match(r.headers.get('content-type'), /application\/json/, f);
      assert.doesNotThrow(() => JSON.parse(r.text), f);
    } else {
      assert.match(r.headers.get('content-type'), /text\/html/, f);
      // Our own pages (gallery, bubble) may frame avatars; other origins may not.
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/, f);
      assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', f);
    }
  }
  if (fs.existsSync(path.join(dir, 'index.json'))) {
    const idx = await api('GET', '/web/avatars/index.json');
    assert.equal(idx.status, 200);
    assert.match(idx.headers.get('content-type'), /application\/json/);
  } else {
    t.diagnostic('web/avatars/index.json not present');
  }
  // Everything else keeps frame-ancestors 'none'.
  const home = await api('GET', '/');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
});

test('CLI assistant commands talk to the running server', async () => {
  const port = String(srv.port);
  const remind = await cli(['remind', 'in 10 minutes stretch your legs', '--port', port, '--json']);
  assert.equal(remind.status, 0, remind.stderr + remind.stdout);
  const task = JSON.parse(remind.stdout);
  assert.equal(task.kind, 'reminder');
  assert.ok(task.id);

  const list = await cli(['tasks', '--port', port, '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.ok(JSON.parse(list.stdout).tasks.some((x) => x.id === task.id));

  const cancel = await cli(['tasks', 'cancel', task.id, '--port', port]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled/);

  const approvals = await cli(['approvals', '--port', port, '--json']);
  assert.equal(approvals.status, 0, approvals.stderr);
  assert.deepEqual(JSON.parse(approvals.stdout).pending, []);

  const shopping = await cli(['shopping', '--port', port]);
  assert.equal(shopping.status, 0, shopping.stderr);
  assert.match(shopping.stdout, /never pays/);

  const chat = await cli(['chat', 'hello from the CLI', '--port', port]);
  assert.equal(chat.status, 0, chat.stderr + chat.stdout);
  assert.match(chat.stdout, /hello from the CLI/);
  assert.match(chat.stderr, /--conversation/);
});

test('CLI assistant commands explain how to start the server when it is not running', async () => {
  // Grab a free port, then close it so nothing listens there.
  const net = await import('node:net');
  const freePort = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const r = await cli(['tasks', '--port', String(freePort)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not running/);
  assert.match(r.stderr, /node bin\/cairn\.js serve/);
  assert.match(r.stderr, /node bin\/cairn\.js desktop/);
});

test('CLI help lists the assistant commands', async () => {
  const r = await cli(['help']);
  assert.equal(r.status, 0);
  for (const cmd of ['chat', 'remind', 'tasks', 'approvals', 'shopping', 'assistant', 'desktop']) assert.match(r.stdout, new RegExp(`\\n  ${cmd}\\b`), cmd);
  assert.match(r.stdout, /\n {2}desktop --install\b/, 'help documents desktop --install');
  assert.match(r.stdout, /desktop --install \[--no-launch\] \[--no-dock\]/, 'help documents desktop --install --no-dock');
});

test('CLI desktop rejects flag combinations that do not fit --install (before running any script)', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const noLaunch = await cli(['desktop', '--no-launch']);
  assert.equal(noLaunch.status, 2, noLaunch.stderr);
  assert.match(noLaunch.stderr, /--no-launch only applies to desktop --install/);
  const mixed = await cli(['desktop', '--install', '--quit']);
  assert.equal(mixed.status, 2, mixed.stderr);
  assert.match(mixed.stderr, /cannot be combined/);
  const noDock = await cli(['desktop', '--no-dock']);
  assert.equal(noDock.status, 2, noDock.stderr);
  assert.match(noDock.stderr, /--no-dock only applies to desktop --install/);
});

test('startServer({assistant:false}) does not mount or start the assistant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-server-noassistant-'));
  const rt = await createRuntime({ dataDir: dir });
  const s = await startServer({ runtime: rt, port: 0, assistant: false });
  try {
    assert.equal(s.assistant, null);
    const r = await fetch(`${s.url}/api/assistant/health`);
    assert.equal(r.status, 503);
    await r.text();
    assert.equal(fs.existsSync(path.join(dir, 'tasks.json')), false);
  } finally {
    await s.close();
    await rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('close() stops the scheduler and the process exits cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-server-close-'));
  const script = `
    process.env.CAIRN_MAC_DRYRUN = '1';
    const { createRuntime } = await import(${JSON.stringify(path.join(ROOT, 'src', 'runtime.js'))});
    const { startServer } = await import(${JSON.stringify(path.join(ROOT, 'src', 'server', 'app.js'))});
    const rt = await createRuntime({ dataDir: ${JSON.stringify(dir)} });
    rt.config.agent.claudeBin = ${JSON.stringify(FAKE_CLAUDE)};
    const s = await startServer({ runtime: rt, port: 0 });
    const a = s.assistant;
    const h = await (await fetch(s.url + '/api/assistant/health')).json();
    // Keep a global event stream open so close() has to end it.
    const ev = await fetch(s.url + '/api/assistant/events');
    const reader = ev.body.getReader();
    await reader.read();
    await s.close();
    await rt.close();
    console.log(JSON.stringify({ before: h.scheduler.running, started: a.started, schedulerRunning: a.scheduler.running }));
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('timeout');
      }, 15000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0, `child exited with ${code}: ${stderr}`);
    const outcome = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(outcome.before, true);
    assert.equal(outcome.started, false);
    assert.equal(outcome.schedulerRunning, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
