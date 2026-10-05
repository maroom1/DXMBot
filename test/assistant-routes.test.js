// /api/assistant/* routes (src/assistant/routes.js) against a real AssistantAgent
// driven by the fake Claude CLI, the real ApprovalQueue / TaskScheduler, and
// macOS actions in dry-run mode (nothing is sent to Reminders/Calendar).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CAIRN_MAC_DRYRUN = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude-assistant.js');

const { createAssistant, loadSettings, DEFAULT_SETTINGS } = await import('../src/assistant/routes.js');

let tmp;
let runtime;
let assistant;
let server;
let base;
let port;

async function makeRuntime(dataDir) {
  try {
    const { createRuntime } = await import('../src/runtime.js');
    return await createRuntime({ dataDir });
  } catch {
    const { loadConfig } = await import('../src/config.js');
    const { AuditLog } = await import('../src/util/audit.js');
    return { config: loadConfig({ dataDir }), audit: new AuditLog(), close: async () => {} };
  }
}

// Read a JSON body the way src/server/app.js does, to exercise handle(..., {body}).
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function api(method, pathname, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

// Minimal SSE client: collects {event, data, id} frames and comment lines.
function sse(pathname, headers = {}) {
  const events = [];
  const comments = [];
  const waiters = new Set();
  let buf = '';
  let ended = false;
  let contentType = null;
  const check = () => {
    for (const w of [...waiters]) {
      const hit = events.find(w.pred);
      if (hit) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(hit);
      } else if (ended) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(new Error(`stream ended before expected event; got: ${events.map((e) => e.event).join(',')}`));
      }
    }
  };
  const parseFrame = (frame) => {
    let event = 'message';
    let id = null;
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) comments.push(line);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
      else if (line.startsWith('id: ')) id = line.slice(4);
    }
    if (!data.length) return;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      parsed = data.join('\n');
    }
    events.push({ event, data: parsed, id });
  };
  let req = null;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      contentType = res.headers['content-type'];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          parseFrame(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
        check();
      });
      res.on('end', () => {
        ended = true;
        check();
      });
      res.on('close', () => {
        ended = true;
        check();
      });
      resolve(res);
    });
    req.on('error', (err) => {
      ended = true;
      check();
      reject(err);
    });
  });
  const client = {
    events,
    comments,
    ready,
    get ended() {
      return ended;
    },
    get contentType() {
      return contentType;
    },
    waitFor(pred, ms = 8000) {
      const p = typeof pred === 'string' ? (e) => e.event === pred : pred;
      return new Promise((resolve, reject) => {
        const w = { pred: p, resolve, reject, timer: setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`timed out waiting for SSE event; got: ${events.map((e) => e.event).join(',')}`));
        }, ms) };
        waiters.add(w);
        check();
      });
    },
    close() {
      req?.destroy();
    },
  };
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await sleep(20);
  }
}

describe('assistant routes', () => {
  let events; // global /api/assistant/events stream

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-assistant-routes-'));
    runtime = await makeRuntime(tmp);
    runtime.config.agent.claudeBin = FAKE_CLAUDE;
    assistant = createAssistant({ runtime, tickMs: 50, heartbeatMs: 150 });
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const opts = {};
      // Simulate src/server/app.js, which parses the body before delegating.
      if (req.headers['x-test-preparsed'] === '1' && req.method === 'POST') opts.body = await readBody(req);
      const handled = await assistant.handle(req, res, url, opts);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not handled by assistant', fallback: true }));
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
    runtime.config.publicBaseUrl = base;
    await assistant.start();
    events = sse('/api/assistant/events');
    await events.ready;
    await events.waitFor('hello');
  });

  after(async () => {
    events?.close();
    await assistant?.stop();
    await new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
    await runtime?.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('health reports claude, scheduler, runs and approvals', async () => {
    const r = await api('GET', '/api/assistant/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.claude.available, true);
    assert.equal(typeof r.json.scheduler.active, 'number');
    assert.equal(r.json.pendingApprovals, 0);
    assert.equal(r.json.runningRuns, 0);
    assert.equal(r.json.queuedRuns, 0);
    assert.ok('nextTaskAt' in r.json);
  });

  it('returns false for paths outside /api/assistant/ and 404/405 inside it', async () => {
    const direct = await assistant.handle({ method: 'GET', headers: {} }, {}, new URL('http://127.0.0.1/api/search?q=x'));
    assert.equal(direct, false);
    const viaServer = await api('GET', '/api/search?q=x');
    assert.equal(viaServer.status, 404);
    assert.equal(viaServer.json.fallback, true);
    const unknown = await api('GET', '/api/assistant/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.fallback, undefined);
    const wrongMethod = await api('DELETE', '/api/assistant/health', {});
    assert.equal(wrongMethod.status, 405);
  });

  it('enforces content type, origin and body size guards', async () => {
    const noType = await api('POST', '/api/assistant/chat', JSON.stringify({ message: 'hi' }), { 'Content-Type': 'text/plain' });
    assert.equal(noType.status, 415);
    const delNoType = await fetch(`${base}/api/assistant/shopping/x`, { method: 'DELETE' });
    assert.equal(delNoType.status, 415);
    await delNoType.text();
    const evilPost = await api('POST', '/api/assistant/chat', { message: 'hi' }, { Origin: 'http://evil.example' });
    assert.equal(evilPost.status, 403);
    const evilGet = await api('GET', '/api/assistant/tasks', undefined, { Origin: 'http://evil.example' });
    assert.equal(evilGet.status, 403);
    const crossSite = await api('GET', '/api/assistant/tasks', undefined, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await api('GET', '/api/assistant/tasks', undefined, { Origin: base });
    assert.equal(sameOrigin.status, 200);
    const big = await api('POST', '/api/assistant/shopping', JSON.stringify({ item: 'x'.repeat(1024 * 1024 + 10) }));
    assert.equal(big.status, 413);
    const badJson = await api('POST', '/api/assistant/shopping', '{nope');
    assert.equal(badJson.status, 400);
  });

  it('settings roundtrip, validation and persistence', async () => {
    const g = await api('GET', '/api/assistant/settings');
    assert.equal(g.status, 200);
    assert.equal(g.json.maxBudgetUsd, DEFAULT_SETTINGS.maxBudgetUsd);
    assert.equal(DEFAULT_SETTINGS.isolateClaudeSettings, true);
    assert.equal(DEFAULT_SETTINGS.workDir, path.join(os.homedir(), 'CairnWorkspace'));
    assert.equal(g.json.notifyOnComplete, true);
    assert.equal(g.json.maxConcurrentRuns, 3);
    const p = await api('POST', '/api/assistant/settings', { maxBudgetUsd: 3.5, workDir: tmp, model: 'sonnet' });
    assert.equal(p.status, 200);
    assert.equal(p.json.maxBudgetUsd, 3.5);
    assert.equal(assistant.settings.workDir, path.resolve(tmp));
    const saved = loadSettings(path.join(tmp, 'assistant-settings.json'));
    assert.equal(saved.maxBudgetUsd, 3.5);
    assert.equal(saved.model, 'sonnet');
    assert.equal((await api('POST', '/api/assistant/settings', { bogus: 1 })).status, 400);
    assert.equal((await api('POST', '/api/assistant/settings', { maxBudgetUsd: 'lots' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/settings', { workDir: path.join(tmp, 'missing-dir') })).status, 400);
    assert.equal((await api('POST', '/api/assistant/settings', { notifyWithMac: 'yes' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/settings', { isolateClaudeSettings: 'no' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/settings', { isolateClaudeSettings: false })).json.isolateClaudeSettings, false);
    assert.equal((await api('POST', '/api/assistant/settings', { isolateClaudeSettings: true })).json.isolateClaudeSettings, true);
    const again = await api('GET', '/api/assistant/settings');
    assert.equal(again.json.settings.maxBudgetUsd, 3.5);
  });

  let convId;
  let runId;

  it('chat starts a background run that streams text + done and is listed in /runs', async () => {
    const r = await api('POST', '/api/assistant/chat', { message: 'Hello there' });
    assert.equal(r.status, 202);
    assert.match(r.json.runId, /\S/);
    assert.match(r.json.conversationId, /\S/);
    ({ runId, conversationId: convId } = r.json);

    const stream = sse(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
    await stream.ready;
    assert.match(stream.contentType, /^text\/event-stream/);
    await stream.waitFor('done', 15000);
    const types = stream.events.map((e) => e.event);
    assert.ok(types.includes('text'), `expected a text event, got ${types.join(',')}`);
    const text = stream.events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');
    assert.match(text, /You said: Hello there/);
    assert.ok(stream.events.every((e) => e.data && e.data.type === e.event));
    stream.close();

    const started = await events.waitFor((e) => e.event === 'run_started' && e.data.run.runId === runId);
    assert.equal(started.data.run.conversationId, convId);
    const done = await events.waitFor((e) => e.event === 'run_done' && e.data.run.runId === runId);
    assert.equal(done.data.run.state, 'done');
    assert.match(done.data.text, /You said: Hello there/);

    const runs = await api('GET', '/api/assistant/runs');
    assert.equal(runs.status, 200);
    const row = runs.json.runs.find((x) => x.runId === runId);
    assert.ok(row, 'run listed');
    assert.equal(row.state, 'done');

    const one = await api('GET', `/api/assistant/runs/${runId}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.run.runId, runId);

    // notifyOnComplete → macOS notification (dry run)
    assert.ok(await eventually(() => assistant.notifications.some((n) => n.title === 'Cairn finished: Hello there' && /You said/.test(n.message))));
  });

  it('background runs: run_update broadcasts, health counts, cancel without a completion notification', async () => {
    process.env.FAKE_CLAUDE_MODE = 'slow';
    process.env.FAKE_SLOW_MS = '30000';
    try {
      const r = await api('POST', '/api/assistant/chat', { message: 'Organize my Downloads folder' });
      assert.equal(r.status, 202);
      const id = r.json.runId;
      await events.waitFor((e) => e.event === 'run_update' && e.data.run.runId === id && e.data.run.state === 'running', 10000);
      const h = await api('GET', '/api/assistant/health');
      assert.ok(h.json.runningRuns >= 1, 'runningRuns counts the background run');
      // The run keeps going without any SSE client attached; now cancel it.
      const c = await api('POST', `/api/assistant/runs/${id}/cancel`, {});
      assert.equal(c.status, 200);
      assert.equal(c.json.ok, true);
      const done = await events.waitFor((e) => e.event === 'run_done' && e.data.run.runId === id, 10000);
      assert.equal(done.data.run.state, 'cancelled');
      await sleep(50);
      assert.ok(!assistant.notifications.some((n) => /Organize my Downloads/.test(n.title)), 'no notification for a cancelled run');
      assert.equal((await api('GET', '/api/assistant/health')).json.runningRuns, 0);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
      delete process.env.FAKE_SLOW_MS;
    }
  });

  it('replays run events after Last-Event-ID and 404s unknown runs', async () => {
    const all = sse(`/api/assistant/runs/${runId}/events`);
    await all.waitFor('done');
    const resumed = sse(`/api/assistant/runs/${runId}/events`, { 'Last-Event-ID': '1' });
    await resumed.waitFor('done');
    assert.equal(resumed.events.length, all.events.length - 2);
    all.close();
    resumed.close();
    assert.equal((await api('GET', '/api/assistant/runs/run-missing/events')).status, 404);
    assert.equal((await api('POST', '/api/assistant/runs/run-missing/cancel', {})).status, 404);
  });

  it('conversations list/get and follow-up chat in the same conversation', async () => {
    const list = await api('GET', '/api/assistant/conversations');
    assert.ok(list.json.conversations.some((c) => c.id === convId));
    const r = await api('POST', '/api/assistant/chat', { message: 'And again', conversationId: convId }, { 'X-Test-Preparsed': '1' });
    assert.equal(r.status, 202);
    assert.equal(r.json.conversationId, convId);
    await events.waitFor((e) => e.event === 'run_done' && e.data.run.runId === r.json.runId, 15000);
    const conv = await api('GET', `/api/assistant/conversations/${convId}`);
    assert.equal(conv.status, 200);
    const roles = conv.json.conversation.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    assert.equal((await api('POST', '/api/assistant/chat', { message: 'x', conversationId: 'c-nope' })).status, 404);
    assert.equal((await api('POST', '/api/assistant/chat', { message: '   ' })).status, 400);
  });

  it('approvals: create → pending → wait (timeout) → resolve early → always-allow', async () => {
    const created = await api('POST', '/api/assistant/approvals', { toolName: 'Bash', input: { command: 'ls -la ~/Downloads' }, conversationId: convId, runId: 'run-ext' });
    assert.equal(created.status, 200);
    const { id } = created.json;
    assert.match(id, /\S/);

    const ev = await events.waitFor((e) => e.event === 'approval' && e.data.approval.id === id);
    assert.equal(ev.data.approval.summary, 'Run shell command: ls -la ~/Downloads');
    assert.ok(await eventually(() => assistant.notifications.some((n) => n.title === 'Cairn needs your approval' && /ls -la/.test(n.message))));

    const pending = await api('GET', '/api/assistant/approvals');
    assert.ok(pending.json.pending.some((p) => p.id === id && p.toolName === 'Bash'));
    assert.equal((await api('GET', '/api/assistant/health')).json.pendingApprovals, 1);

    const t0 = Date.now();
    const short = await api('GET', `/api/assistant/approvals/${id}/wait?timeout=1`);
    assert.deepEqual(short.json, { decided: false });
    assert.ok(Date.now() - t0 >= 900, 'honours ?timeout');

    const t1 = Date.now();
    const waiting = api('GET', `/api/assistant/approvals/${id}/wait?timeout=30`);
    await sleep(150);
    const decided = await api('POST', `/api/assistant/approvals/${id}`, { allow: true, always: true });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.ok, true);
    const w = await waiting;
    assert.equal(w.json.decided, true);
    assert.equal(w.json.decision.allow, true);
    assert.ok(Date.now() - t1 < 5000, 'long-poll resolved early');

    const resolvedEv = await events.waitFor((e) => e.event === 'approval_resolved' && e.data.id === id);
    assert.equal(resolvedEv.data.allow, true);
    const conv = await api('GET', `/api/assistant/conversations/${convId}`);
    assert.ok(conv.json.allowAlways.includes('Bash'));

    assert.equal((await api('POST', `/api/assistant/approvals/${id}`, { allow: false })).status, 409);
    const after = await api('GET', `/api/assistant/approvals/${id}/wait?timeout=0`);
    assert.equal(after.json.decided, true);
    assert.equal((await api('GET', '/api/assistant/approvals/ap-missing/wait?timeout=0')).status, 404);
    assert.equal((await api('POST', '/api/assistant/approvals', { input: {} })).status, 400);
  });

  it('approvals: deny path returns a message', async () => {
    const { json } = await api('POST', '/api/assistant/approvals', { toolName: 'mcp__playwright__browser_click', input: { element: 'Add to cart' } });
    const waiting = api('GET', `/api/assistant/approvals/${json.id}/wait?timeout=10`);
    await sleep(50);
    await api('POST', `/api/assistant/approvals/${json.id}`, { allow: false, message: 'Not now' });
    const w = await waiting;
    assert.equal(w.json.decided, true);
    assert.equal(w.json.decision.allow, false);
    assert.equal(w.json.decision.message, 'Not now');
  });

  it('tasks: parse, create from text, list, cancel', async () => {
    const parsed = await api('POST', '/api/assistant/tasks/parse', { text: 'remind me to stretch in 10 minutes' });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.json.ok, true);
    const dt = Date.parse(parsed.json.when) - Date.now();
    assert.ok(dt > 9 * 60_000 && dt < 11 * 60_000, `when ≈ now+10min, got ${parsed.json.when}`);
    assert.match(parsed.json.title, /stretch/i);
    const nope = await api('POST', '/api/assistant/tasks/parse', { text: 'banana' });
    assert.equal(nope.json.ok, false);

    const created = await api('POST', '/api/assistant/tasks', { text: 'remind me to stretch in 10 minutes' });
    assert.equal(created.status, 201);
    const task = created.json.task;
    assert.match(task.id, /\S/);
    assert.match(task.title, /stretch/i);
    assert.equal(task.kind, 'reminder');

    const recurring = await api('POST', '/api/assistant/tasks', { title: 'Standup', when: new Date(Date.now() + 3600_000).toISOString(), recurrence: { every: 'weekday', at: '09:00' } });
    assert.equal(recurring.status, 201);
    assert.equal(recurring.json.task.recurrence.every, 'weekday');

    const list = await api('GET', '/api/assistant/tasks');
    const ids = list.json.tasks.map((t) => t.id);
    assert.ok(ids.includes(task.id) && ids.includes(recurring.json.task.id));
    const health = await api('GET', '/api/assistant/health');
    assert.ok(health.json.scheduler.active >= 2);
    assert.ok(health.json.nextTaskAt);

    const del = await api('DELETE', `/api/assistant/tasks/${task.id}`, {});
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    const after = await api('GET', '/api/assistant/tasks');
    assert.ok(!after.json.tasks.some((t) => t.id === task.id));
    assert.equal((await api('DELETE', '/api/assistant/tasks/t-missing', {})).status, 404);
    assert.equal((await api('POST', '/api/assistant/tasks', { title: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/tasks', { title: 'x', when: 'not a date' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/tasks', { title: 'x', when: new Date().toISOString(), kind: 'bogus' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/tasks', { text: 'something vague' })).status, 400);
    await api('DELETE', `/api/assistant/tasks/${recurring.json.task.id}`, {});
  });

  it('a due reminder is broadcast on /events and notified', async () => {
    const when = new Date(Date.now() + 250).toISOString();
    const created = await api('POST', '/api/assistant/tasks', { title: 'Drink water', when, notes: 'a full glass' });
    assert.equal(created.status, 201);
    const ev = await events.waitFor((e) => e.event === 'reminder' && e.data.task.id === created.json.task.id, 8000);
    assert.equal(ev.data.task.title, 'Drink water');
    assert.ok(await eventually(() => assistant.notifications.some((n) => n.title === 'Cairn reminder' && /Drink water/.test(n.message))));
  });

  it('run-now on a task and a scheduled agent task produce task_result', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = await api('POST', '/api/assistant/tasks', { title: 'Later', when: future });
    const run = await api('POST', `/api/assistant/tasks/${r.json.task.id}/run`, {});
    assert.equal(run.status, 200);
    await events.waitFor((e) => e.event === 'reminder' && e.data.task.id === r.json.task.id, 8000);

    const agentTask = await api('POST', '/api/assistant/tasks', { kind: 'agent', title: 'Morning digest', prompt: 'Summarize my day', when: new Date(Date.now() + 200).toISOString() });
    assert.equal(agentTask.status, 201);
    const result = await events.waitFor((e) => e.event === 'task_result' && e.data.task.id === agentTask.json.task.id, 20000);
    assert.equal(result.data.ok, true);
    assert.match(result.data.text, /Summarize my day/);
    assert.ok(assistant.notifications.some((n) => n.title === 'Cairn finished: Morning digest'));
    // The unattended run itself must not produce a second "finished" notification.
    assert.ok(!assistant.notifications.some((n) => /^Cairn finished: Scheduled/.test(n.title)));
  });

  it('shopping list CRUD', async () => {
    const add = await api('POST', '/api/assistant/shopping', { item: 'USB-C cable', url: 'https://example.com/cable', price: '$9.99', store: 'Example Store', notes: '2 m' });
    assert.equal(add.status, 200);
    const item = add.json.item;
    assert.equal(item.item, 'USB-C cable');
    assert.equal(item.price, '$9.99');
    const list = await api('GET', '/api/assistant/shopping');
    assert.ok(list.json.items.some((i) => i.id === item.id));
    assert.equal((await api('POST', '/api/assistant/shopping', { item: 'x', url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/shopping', { url: 'https://example.com' })).status, 400);
    const upd = await api('POST', `/api/assistant/shopping/${item.id}`, { done: true, price: 8.5 });
    assert.equal(upd.json.item.done, true);
    assert.equal(upd.json.item.price, 8.5);
    const del = await api('DELETE', `/api/assistant/shopping/${item.id}`, {});
    assert.equal(del.json.ok, true);
    assert.equal((await api('DELETE', `/api/assistant/shopping/${item.id}`, {})).status, 404);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'shopping.json'), 'utf8'));
    assert.equal(saved.items.length, 0);
  });

  it('macOS actions run in dry-run mode and validate input', async () => {
    const rem = await api('POST', '/api/assistant/mac/reminder', { title: 'Buy "milk"', due: '2026-10-01T09:00:00' });
    assert.equal(rem.status, 200);
    assert.equal(rem.json.dryRun, true);
    assert.match(rem.json.script, /Buy \\"milk\\"/);
    const cal = await api('POST', '/api/assistant/mac/calendar', { title: 'Dentist', start: '2026-10-02T14:00:00' });
    assert.equal(cal.json.dryRun, true);
    assert.equal((await api('POST', '/api/assistant/mac/calendar', { title: 'Dentist', start: 'tomorrow' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/open', { url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/open', { url: 'https://example.com' })).json.dryRun, true);
    assert.equal((await api('POST', '/api/assistant/open', { app: 'Safari' })).json.dryRun, true);
    assert.equal((await api('POST', '/api/assistant/open', { app: '-n' })).status, 400);
    assert.equal((await api('POST', '/api/assistant/open', {})).status, 400);
    assert.equal((await api('POST', '/api/assistant/clipboard', { op: 'write', text: 'hi' })).json.dryRun, true);
    assert.equal((await api('POST', '/api/assistant/clipboard', { op: 'nuke' })).status, 400);
    const n = await api('POST', '/api/assistant/notify', { title: 'Hi', message: 'Hello' });
    assert.equal(n.json.dryRun, true);
    await events.waitFor((e) => e.event === 'notification' && e.data.message === 'Hello');
  });

  it('SSE streams send heartbeat comments and clean up on close', async () => {
    const s = sse('/api/assistant/events');
    await s.waitFor('hello');
    await sleep(400);
    assert.ok(s.comments.some((c) => c.startsWith(': heartbeat')), 'heartbeat comment received');
    s.close();
  });

  it('deleting a conversation removes it', async () => {
    const del = await api('DELETE', `/api/assistant/conversations/${convId}`, {});
    assert.equal(del.status, 200);
    assert.equal((await api('GET', `/api/assistant/conversations/${convId}`)).status, 404);
    assert.equal((await api('DELETE', `/api/assistant/conversations/${convId}`, {})).status, 404);
  });
});
