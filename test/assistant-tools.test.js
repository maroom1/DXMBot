// Tests for the assistant MCP server (src/assistant/mcp-tools.js) and the macOS
// bridge (src/assistant/macos.js). Everything runs with CAIRN_MAC_DRYRUN=1 so no
// real Reminders/Calendar entries, notifications or app launches happen.
// Opt-in live checks: CAIRN_LIVE_MAC=1 (one real notification),
// CAIRN_LIVE_CLAUDE=1 (one real haiku call through --permission-prompt-tool).
process.env.CAIRN_MAC_DRYRUN = '1';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as macos from '../src/assistant/macos.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'assistant', 'mcp-tools.js');

const EXPECTED_TOOLS = [
  'schedule_task', 'list_tasks', 'cancel_task', 'notify', 'apple_reminder', 'calendar_event', 'open_url', 'open_app',
  'web_research', 'shopping_list_add', 'shopping_list', 'shopping_list_remove', 'clipboard_read', 'clipboard_write', 'approval_prompt',
];

// ---------- in-test fake Cairn API ----------
function startFakeApi() {
  const state = {
    requests: [],
    approvals: new Map(), // id → {decided, decision, waits}
    decide: null, // (approval, waitCount) → decision|null
    nextApproval: 1,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let json = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = '<<invalid json>>';
      }
      state.requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: json });
      const reply = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      // Mirror Cairn's guard: POST/DELETE must be JSON.
      if ((req.method === 'POST' || req.method === 'DELETE') && req.headers['content-type'] !== 'application/json') return reply(415, { error: 'json required' });
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (req.method === 'POST' && p === '/api/assistant/tasks') {
        return reply(201, { task: { id: 't-1', status: 'active', createdAt: new Date().toISOString(), nextRunAt: json.when, runs: [], ...json } });
      }
      if (req.method === 'GET' && p === '/api/assistant/tasks') {
        return reply(200, {
          tasks: [
            { id: 't-1', title: 'Call mom', kind: 'reminder', status: 'active', nextRunAt: '2026-10-01T16:00:00.000Z', recurrence: null },
            { id: 't-2', title: 'AI news', kind: 'agent', prompt: 'Summarise AI news', status: 'active', nextRunAt: '2026-10-02T15:00:00.000Z', recurrence: { every: 'weekday', at: '08:00' } },
          ],
        });
      }
      if (req.method === 'DELETE' && p.startsWith('/api/assistant/tasks/')) {
        if (p.endsWith('/missing')) return reply(404, { error: 'task not found' });
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/assistant/notify') return reply(200, { ok: true, dryRun: true });
      if (req.method === 'POST' && p === '/api/assistant/mac/reminder') return reply(200, { ok: true, list: json.list || 'Reminders' });
      if (req.method === 'POST' && p === '/api/assistant/mac/calendar') return reply(200, { ok: true, calendar: 'Home' });
      if (req.method === 'POST' && p === '/api/assistant/open') {
        if (json.app === 'Nope') return reply(200, { ok: false, error: 'Unable to find application named Nope' });
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/search') {
        return reply(200, { query: json.query, total: 1, results: [{ url: 'http://shop.test/tent', title: 'Ridgeback tent', snippet: '1.2 kg', score: 2 }] });
      }
      if (req.method === 'POST' && p === '/api/assistant/shopping') return reply(200, { item: { id: 's-1', createdAt: 'now', ...json } });
      if (req.method === 'GET' && p === '/api/assistant/shopping') {
        return reply(200, { items: [{ id: 's-1', item: 'Tent', price: '$199', store: 'REI', url: 'https://rei.test/tent' }] });
      }
      if (req.method === 'DELETE' && p.startsWith('/api/assistant/shopping/')) return reply(200, { ok: true });
      if (req.method === 'POST' && p === '/api/assistant/clipboard') {
        if (json.op === 'read') return reply(200, { ok: true, text: 'copied "text"' });
        return reply(200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/assistant/approvals') {
        const id = `ap-${state.nextApproval++}`;
        state.approvals.set(id, { id, ...json, waits: 0 });
        return reply(200, { id });
      }
      const m = /^\/api\/assistant\/approvals\/([^/]+)\/wait$/.exec(p);
      if (req.method === 'GET' && m) {
        const a = state.approvals.get(decodeURIComponent(m[1]));
        if (!a) return reply(404, { error: 'unknown approval' });
        a.waits++;
        const decision = state.decide ? state.decide(a, a.waits) : null;
        if (decision) return reply(200, { decided: true, decision });
        // Simulate a short long-poll window.
        return setTimeout(() => reply(200, { decided: false }), 50);
      }
      reply(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

// ---------- line-oriented JSON-RPC client ----------
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.messages = [];
    this.waiters = [];
    this.stderr = '';
    this.nextId = 1;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line); // stdout must be pure protocol
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => !w(msg));
      }
    });
    this.child.stderr.on('data', (d) => (this.stderr += d));
  }
  waitFor(pred, timeoutMs = 10_000) {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for message; stderr: ${this.stderr}`)), timeoutMs);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        resolve(msg);
        return true;
      });
    });
  }
  request(method, params, timeoutMs) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return this.waitFor((m) => m.id === id, timeoutMs);
  }
  async call(name, args, timeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    assert.ok(res.result, `tools/call ${name} returned error ${JSON.stringify(res.error)}`);
    return { ...res.result, text: res.result.content.map((c) => c.text).join('\n') };
  }
  async init() {
    const res = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res;
  }
  close() {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once('exit', resolve);
      this.child.stdin.end();
      setTimeout(() => this.child.kill('SIGKILL'), 4000).unref();
    });
  }
}

const lastRequest = (state, method, pathname) =>
  [...state.requests].reverse().find((r) => r.method === method && new URL(r.url, 'http://x').pathname === pathname);

// ---------- MCP server ----------
describe('assistant MCP server', () => {
  let api;
  let client;
  before(async () => {
    api = await startFakeApi();
    client = new McpClient({ CAIRN_API: api.url, CAIRN_CONVERSATION_ID: 'conv-1', CAIRN_RUN_ID: 'run-1', CAIRN_APPROVAL_POLL_MS: '200', CAIRN_APPROVAL_MAX_MS: '5000', CAIRN_UNATTENDED: '0' });
    await client.init();
  });
  after(async () => {
    await client?.close();
    api?.server.close();
  });

  test('initialize identifies the server as "assistant"', async () => {
    const res = await client.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(res.result.serverInfo.name, 'assistant');
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.protocolVersion, '2025-06-18');
  });

  test('tools/list exposes every tool with a valid JSON schema', async () => {
    const res = await client.request('tools/list', {});
    const tools = res.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      assert.ok(t.description && t.description.length >= 60, `${t.name} needs a real description`);
      const s = t.inputSchema;
      assert.equal(s.type, 'object', t.name);
      assert.equal(typeof s.properties, 'object', t.name);
      for (const r of s.required || []) assert.ok(r in s.properties, `${t.name}: required "${r}" missing from properties`);
      for (const [k, v] of Object.entries(s.properties)) {
        assert.ok(typeof v.type === 'string', `${t.name}.${k} needs a type`);
        if (v.enum) assert.ok(Array.isArray(v.enum) && v.enum.length, `${t.name}.${k} enum`);
      }
      JSON.parse(JSON.stringify(s)); // serialisable
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(byName.schedule_task.inputSchema.required, ['title', 'when']);
    assert.deepEqual(byName.schedule_task.inputSchema.properties.kind.enum, ['reminder', 'agent']);
    assert.deepEqual(byName.schedule_task.inputSchema.properties.recurrence.properties.every.enum, ['minute', 'hour', 'day', 'week', 'weekday']);
    assert.deepEqual(byName.approval_prompt.inputSchema.required, ['tool_name', 'input']);
    // Guidance for Claude about which tool to use.
    assert.match(byName.schedule_task.description, /remind me/i);
    assert.match(byName.apple_reminder.description, /ONLY when the user explicitly/);
    assert.match(byName.shopping_list_add.description, /NEVER place orders/);
    assert.match(byName.web_research.description, /WebSearch/);
    assert.match(byName.approval_prompt.description, /Do NOT call this tool yourself/);
  });

  test('unknown tool / method errors', async () => {
    const res = await client.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(res.error.code, -32602);
    const res2 = await client.request('bogus/method', {});
    assert.equal(res2.error.code, -32601);
  });

  test('schedule_task proxies a normalized body to POST /api/assistant/tasks', async () => {
    const r = await client.call('schedule_task', {
      title: 'Stand-up',
      when: '2099-03-04T09:15:00',
      recurrence: { every: 'weekday', at: '9:15' },
      notes: 'Room "B"',
    });
    assert.equal(r.isError, false, r.text);
    const req = lastRequest(api.state, 'POST', '/api/assistant/tasks');
    assert.equal(req.contentType, 'application/json');
    assert.equal(req.body.title, 'Stand-up');
    assert.equal(req.body.kind, 'reminder');
    assert.equal(req.body.notes, 'Room "B"');
    assert.deepEqual(req.body.recurrence, { every: 'weekday', at: '09:15' });
    // Local time without offset → local ISO with explicit offset, same instant.
    assert.match(req.body.when, /^2099-03-04T09:15:00[+-]\d{2}:\d{2}$/);
    assert.equal(new Date(req.body.when).getTime(), new Date(2099, 2, 4, 9, 15, 0).getTime());
    assert.ok(!('prompt' in req.body));
    assert.match(r.text, /Scheduled reminder "Stand-up" \(id t-1\)/);
    assert.match(r.text, /repeats every weekday at 09:15/);
  });

  test('schedule_task agent kind with offset time and prompt', async () => {
    const r = await client.call('schedule_task', { title: 'Price watch', when: '2099-01-02T08:00:00Z', kind: 'agent', prompt: 'Check the price of X' });
    assert.equal(r.isError, false, r.text);
    const req = lastRequest(api.state, 'POST', '/api/assistant/tasks');
    assert.equal(req.body.kind, 'agent');
    assert.equal(req.body.prompt, 'Check the price of X');
    assert.equal(new Date(req.body.when).toISOString(), '2099-01-02T08:00:00.000Z');
    assert.match(r.text, /agent task/);
  });

  test('schedule_task rejects bad input without calling the API', async () => {
    const before = api.state.requests.length;
    const bad = [
      [{ title: 'x', when: 'tomorrow at 9' }, /ISO 8601/],
      [{ title: 'x', when: '2001-01-01T09:00:00' }, /in the past/],
      [{ title: 'x', when: '2099-01-01T09:00:00', kind: 'agent' }, /prompt/],
      [{ title: 'x', when: '2099-01-01T09:00:00', kind: 'alarm' }, /kind/],
      [{ title: 'x', when: '2099-01-01T09:00:00', recurrence: { every: 'fortnight' } }, /recurrence.every/],
      [{ title: 'x', when: '2099-01-01T09:00:00', recurrence: { every: 'day', at: '25:00' } }, /HH:MM/],
      [{ title: 'x', when: '2099-01-01T09:00:00', recurrence: { every: 'week', days: ['funday'] } }, /invalid day/],
      [{ when: '2099-01-01T09:00:00' }, /"title" is required/],
    ];
    for (const [args, re] of bad) {
      const r = await client.call('schedule_task', args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re, JSON.stringify(args));
    }
    assert.equal(api.state.requests.length, before);
    // Past times are fine for recurring tasks (the scheduler skips to the next occurrence).
    const ok = await client.call('schedule_task', { title: 'x', when: '2001-01-01T09:00:00', recurrence: { every: 'day', at: '09:00' } });
    assert.equal(ok.isError, false, ok.text);
  });

  test('list_tasks and cancel_task', async () => {
    const list = await client.call('list_tasks', {});
    assert.match(list.text, /2 scheduled item/);
    assert.match(list.text, /\[t-2\] Agent task: "AI news".*repeats every weekday at 08:00/);
    const c = await client.call('cancel_task', { id: 'a/b' });
    assert.equal(c.isError, false);
    const req = lastRequest(api.state, 'DELETE', '/api/assistant/tasks/a%2Fb');
    assert.ok(req, 'DELETE sent with encoded id');
    assert.equal(req.contentType, 'application/json');
    const missing = await client.call('cancel_task', { id: 'missing' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /404.*task not found/);
  });

  test('notify, apple_reminder and calendar_event proxy correct bodies', async () => {
    const n = await client.call('notify', { title: 'Hi', message: 'Done' });
    assert.equal(n.isError, false);
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/notify').body, { title: 'Hi', message: 'Done' });

    const r = await client.call('apple_reminder', { title: 'Milk', due: '2099-05-06T18:00:00', list: 'Groceries' });
    assert.equal(r.isError, false, r.text);
    const rb = lastRequest(api.state, 'POST', '/api/assistant/mac/reminder').body;
    assert.equal(rb.title, 'Milk');
    assert.equal(rb.list, 'Groceries');
    assert.equal(new Date(rb.due).getTime(), new Date(2099, 4, 6, 18, 0, 0).getTime());
    assert.match(r.text, /Groceries/);

    const c = await client.call('calendar_event', { title: 'Dentist', start: '2099-05-07T10:00:00', location: 'Main St' });
    assert.equal(c.isError, false, c.text);
    const cb = lastRequest(api.state, 'POST', '/api/assistant/mac/calendar').body;
    assert.equal(cb.title, 'Dentist');
    assert.equal(cb.location, 'Main St');
    assert.ok(!('end' in cb));
    const bad = await client.call('calendar_event', { title: 'x', start: '2099-05-07T10:00:00', end: '2099-05-07T09:00:00' });
    assert.equal(bad.isError, true);
  });

  test('open_url / open_app', async () => {
    const before = api.state.requests.length;
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'ftp://x.test/']) {
      const r = await client.call('open_url', { url });
      assert.equal(r.isError, true, url);
    }
    assert.equal(api.state.requests.length, before, 'rejected URLs never reach the API');
    const ok = await client.call('open_url', { url: 'https://example.com/cart?x=1' });
    assert.equal(ok.isError, false);
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/open').body, { url: 'https://example.com/cart?x=1' });
    const app = await client.call('open_app', { name: 'Notes' });
    assert.equal(app.isError, false);
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/open').body, { app: 'Notes' });
    const nope = await client.call('open_app', { name: 'Nope' });
    assert.equal(nope.isError, true);
    assert.match(nope.text, /Unable to find application/);
  });

  test('web_research, shopping list and clipboard proxies', async () => {
    const w = await client.call('web_research', { query: 'tent', limit: 50 });
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/search').body, { query: 'tent', limit: 20 });
    assert.match(w.text, /Ridgeback tent/);
    assert.match(w.text, /http:\/\/shop.test\/tent/);

    const add = await client.call('shopping_list_add', { item: 'Tent', url: 'https://rei.test/tent', price: 199.5, store: 'REI' });
    assert.equal(add.isError, false, add.text);
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/shopping').body, { item: 'Tent', url: 'https://rei.test/tent', price: '199.5', store: 'REI' });
    const badUrl = await client.call('shopping_list_add', { item: 'x', url: 'javascript:1' });
    assert.equal(badUrl.isError, true);
    const list = await client.call('shopping_list', {});
    assert.match(list.text, /\[s-1\] Tent — \$199 — REI — https:\/\/rei.test\/tent/);
    await client.call('shopping_list_remove', { id: 's-1' });
    assert.equal(lastRequest(api.state, 'DELETE', '/api/assistant/shopping/s-1').contentType, 'application/json');

    const read = await client.call('clipboard_read', {});
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/clipboard').body, { op: 'read' });
    assert.match(read.text, /copied "text"/);
    await client.call('clipboard_write', { text: 'hello' });
    assert.deepEqual(lastRequest(api.state, 'POST', '/api/assistant/clipboard').body, { op: 'write', text: 'hello' });
  });

  test('approval_prompt allow: posts the request and returns exact allow JSON', async () => {
    api.state.decide = (a, waits) => (waits >= 2 ? { allow: true } : null); // one "not yet" first
    const input = { command: 'ls -la ~/Downloads', description: 'List downloads' };
    const r = await client.call('approval_prompt', { tool_name: 'Bash', input, tool_use_id: 'toolu_1' });
    assert.equal(r.isError, false);
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].text, JSON.stringify({ behavior: 'allow', updatedInput: input }));
    const req = lastRequest(api.state, 'POST', '/api/assistant/approvals');
    assert.equal(req.contentType, 'application/json');
    assert.deepEqual(req.body, { toolName: 'Bash', input, conversationId: 'conv-1', runId: 'run-1', toolUseId: 'toolu_1' });
    const waits = api.state.requests.filter((x) => x.url.startsWith('/api/assistant/approvals/ap-') && x.url.includes('/wait'));
    assert.ok(waits.length >= 2);
    assert.match(waits[0].url, /\/wait\?timeout=1$/);
  });

  test('approval_prompt allow with user-edited input', async () => {
    api.state.decide = () => ({ allow: true, updatedInput: { command: 'ls ~/Downloads' } });
    const r = await client.call('approval_prompt', { tool_name: 'Bash', input: { command: 'rm -rf ~/Downloads' } });
    assert.equal(r.content[0].text, '{"behavior":"allow","updatedInput":{"command":"ls ~/Downloads"}}');
  });

  test('approval_prompt deny returns deny JSON that quotes the user message', async () => {
    api.state.decide = () => ({ allow: false, message: 'Not now, thanks' });
    const r = await client.call('approval_prompt', { tool_name: 'Write', input: { file_path: '/tmp/x', content: 'y' } });
    const p1 = JSON.parse(r.content[0].text);
    assert.deepEqual(Object.keys(p1), ['behavior', 'message']);
    assert.equal(p1.behavior, 'deny');
    assert.match(p1.message, /^The user denied permission to use Write in Cairn and said: "Not now, thanks"\. The action was NOT performed\./);
    api.state.decide = () => ({ allow: false });
    const r2 = await client.call('approval_prompt', { tool_name: 'Write', input: {} });
    const parsed = JSON.parse(r2.content[0].text);
    assert.equal(parsed.behavior, 'deny');
    assert.match(parsed.message, /denied permission to use Write/);
    assert.deepEqual(Object.keys(parsed), ['behavior', 'message']);
  });

  test('approval_prompt attended timeout → deny', async () => {
    api.state.decide = null;
    const c2 = new McpClient({ CAIRN_API: api.url, CAIRN_APPROVAL_POLL_MS: '300', CAIRN_APPROVAL_MAX_MS: '900' });
    try {
      await c2.init();
      const t0 = Date.now();
      const r = await c2.call('approval_prompt', { tool_name: 'Bash', input: { command: 'echo hi' } }, 8000);
      const parsed = JSON.parse(r.content[0].text);
      assert.equal(parsed.behavior, 'deny');
      assert.match(parsed.message, /timed out/);
      assert.ok(Date.now() - t0 < 5000);
    } finally {
      await c2.close();
    }
  });

  test('approval_prompt unattended: denies after the unattended window', async () => {
    api.state.decide = null;
    const c3 = new McpClient({ CAIRN_API: api.url, CAIRN_UNATTENDED: '1', CAIRN_APPROVAL_POLL_MS: '200', CAIRN_APPROVAL_MAX_MS: '60000', CAIRN_APPROVAL_UNATTENDED_MS: '700' });
    try {
      await c3.init();
      const t0 = Date.now();
      const r = await c3.call('approval_prompt', { tool_name: 'mcp__playwright__browser_click', input: { element: 'Add to cart' } }, 8000);
      const parsed = JSON.parse(r.content[0].text);
      assert.equal(parsed.behavior, 'deny');
      assert.match(parsed.message, /unattended/);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 600 && elapsed < 5000, `elapsed ${elapsed}`);
    } finally {
      await c3.close();
    }
  });

  test('approval_prompt denies when the Cairn API is unreachable', async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    const c4 = new McpClient({ CAIRN_API: `http://127.0.0.1:${port}` });
    try {
      await c4.init();
      const r = await c4.call('approval_prompt', { tool_name: 'Bash', input: { command: 'x' } });
      const parsed = JSON.parse(r.content[0].text);
      assert.equal(parsed.behavior, 'deny');
      assert.match(parsed.message, /Could not ask the user/);
    } finally {
      await c4.close();
    }
  });

  test('stdout stays pure protocol (all lines parsed as JSON)', () => {
    assert.ok(client.messages.length > 10);
    assert.match(client.stderr, /ready/);
  });
});

// ---------- macOS bridge (dry-run) ----------
describe('macos.js (dry run)', () => {
  test('escapeAppleScript escapes backslashes, quotes and line breaks', () => {
    assert.equal(macos.escapeAppleScript('say "hi" \\ bye'), 'say \\"hi\\" \\\\ bye');
    assert.equal(macos.escapeAppleScript('a\nb\r\nc\td'), 'a\\nb\\nc\\td');
    assert.equal(macos.escapeAppleScript('x\u0000\u0007y'), 'xy');
    assert.equal(macos.escapeAppleScript(null), '');
    // An injection attempt stays inside the string literal.
    const evil = '" & (do shell script "rm -rf ~") & "';
    const lit = macos.asString(evil);
    assert.equal(lit, '"\\" & (do shell script \\"rm -rf ~\\") & \\""');
  });

  test('notify builds a display notification script with escaped quotes', async () => {
    const r = await macos.notify({ title: 'Cairn "bot"', message: 'Tea is "ready" \\o/' });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.script, 'display notification "Tea is \\"ready\\" \\\\o/" with title "Cairn \\"bot\\"" sound name "Glass"');
    const quiet = await macos.notify({ title: 'T', message: 'M', sound: false });
    assert.equal(quiet.script, 'display notification "M" with title "T"');
  });

  test('addReminder builds the due date from components and escapes text', async () => {
    const r = await macos.addReminder({ title: 'Buy "oat" milk', due: '2026-12-31T23:45:10', list: 'Groceries "home"', notes: 'line1\nline2' });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    const s = r.script;
    for (const line of [
      'set dueDate to current date',
      'set day of dueDate to 1',
      'set year of dueDate to 2026',
      'set month of dueDate to 12',
      'set day of dueDate to 31',
      'set hours of dueDate to 23',
      'set minutes of dueDate to 45',
      'set seconds of dueDate to 10',
      'tell application "Reminders"',
      'if exists list "Groceries \\"home\\"" then',
    ]) assert.ok(s.includes(line), `missing: ${line}\n${s}`);
    // "day 1" reset must precede the month change (no Jan 31 → Mar 3 overflow).
    assert.ok(s.indexOf('set day of dueDate to 1') < s.indexOf('set month of dueDate'));
    assert.ok(s.includes('name:"Buy \\"oat\\" milk"'));
    assert.ok(s.includes('body:"line1\\nline2"'));
    assert.ok(s.includes('due date:dueDate, remind me date:dueDate'));
    assert.ok(!/date "/.test(s), 'never coerce a date string');
    assert.equal(new Date(r.due).getTime(), new Date(2026, 11, 31, 23, 45, 10).getTime());

    const noDue = await macos.addReminder({ title: 'Plain' });
    assert.ok(noDue.script.includes('set targetList to default list'));
    assert.ok(!noDue.script.includes('current date'));
    assert.equal((await macos.addReminder({ title: '' })).ok, false);
    assert.equal((await macos.addReminder({ title: 'x', due: 'next tuesday' })).ok, false);
  });

  test('addCalendarEvent: component dates, default +1h, first writable calendar', async () => {
    const start = '2026-03-08T10:30:00Z';
    const r = await macos.addCalendarEvent({ title: 'Dentist "Dr. A"', start, location: '1 Main St', notes: 'Bring card' });
    assert.equal(r.ok, true);
    const s = r.script;
    const sd = new Date(start);
    const ed = new Date(sd.getTime() + 3600_000);
    assert.ok(s.includes(`set year of startDate to ${sd.getFullYear()}`));
    assert.ok(s.includes(`set month of startDate to ${sd.getMonth() + 1}`));
    assert.ok(s.includes(`set day of startDate to ${sd.getDate()}`));
    assert.ok(s.includes(`set hours of startDate to ${sd.getHours()}`));
    assert.ok(s.includes(`set minutes of startDate to ${sd.getMinutes()}`));
    assert.ok(s.includes(`set hours of endDate to ${ed.getHours()}`));
    assert.ok(s.includes('tell application "Calendar"'));
    assert.ok(s.includes('if writable of c then'));
    assert.ok(s.includes('summary:"Dentist \\"Dr. A\\""'));
    assert.ok(s.includes('location:"1 Main St"'));
    assert.ok(s.includes('description:"Bring card"'));
    assert.ok(!/date "/.test(s));
    assert.equal(new Date(r.end).getTime() - new Date(r.start).getTime(), 3600_000);

    const named = await macos.addCalendarEvent({ title: 'x', start: '2026-03-08T10:00:00', end: '2026-03-08T12:00:00', calendar: 'Work' });
    assert.ok(named.script.includes('if exists calendar "Work" then set targetCal to calendar "Work"'));
    assert.ok(named.script.includes('set hours of endDate to 12'));
    assert.equal((await macos.addCalendarEvent({ title: 'x', start: '2026-03-08T10:00:00', end: '2026-03-08T09:00:00' })).ok, false);
    assert.equal((await macos.addCalendarEvent({ title: 'x', start: 'soon' })).ok, false);
  });

  test('parseIsoLocal handles local, offset and date-only forms', () => {
    assert.equal(macos.parseIsoLocal('2026-10-01T09:00:00').getTime(), new Date(2026, 9, 1, 9, 0, 0).getTime());
    assert.equal(macos.parseIsoLocal('2026-10-01T09:00').getTime(), new Date(2026, 9, 1, 9, 0, 0).getTime());
    assert.equal(macos.parseIsoLocal('2026-10-01T09:00:00-07:00').toISOString(), '2026-10-01T16:00:00.000Z');
    assert.equal(macos.parseIsoLocal('2026-10-01T09:00:00+0530').toISOString(), '2026-10-01T03:30:00.000Z');
    assert.equal(macos.parseIsoLocal('2026-10-01T09:00:00.250Z').toISOString(), '2026-10-01T09:00:00.250Z');
    assert.equal(macos.parseIsoLocal('2026-10-01').getTime(), new Date(2026, 9, 1, 9, 0, 0).getTime());
    for (const bad of ['2026-02-31', '2026-13-01T00:00', 'tomorrow', '10/01/2026', '', null, 42]) assert.equal(macos.parseIsoLocal(bad), null, String(bad));
    const iso = macos.localIso(new Date(2026, 0, 2, 3, 4, 5));
    assert.match(iso, /^2026-01-02T03:04:05[+-]\d{2}:\d{2}$/);
    assert.equal(new Date(iso).getTime(), new Date(2026, 0, 2, 3, 4, 5).getTime());
  });

  test('openUrl allows only http(s)', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'data:text/html,hi', '/relative', 'http://', 'https://exa mple.com', '', null]) {
      const r = await macos.openUrl(bad);
      assert.equal(r.ok, false, String(bad));
      assert.match(r.error, /http/);
    }
    const r = await macos.openUrl('https://example.com/a?b=1');
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.command, ['open', 'https://example.com/a?b=1']);
  });

  test('openApp, clipboard and say in dry-run', async () => {
    const a = await macos.openApp('Visual Studio Code');
    assert.deepEqual(a.command, ['open', '-a', 'Visual Studio Code']);
    assert.equal((await macos.openApp('-n')).ok, false);
    assert.equal((await macos.openApp('')).ok, false);
    const w = await macos.clipboardWrite('secret "x"');
    assert.equal(w.dryRun, true);
    assert.deepEqual(w.command, ['pbcopy']);
    const rd = await macos.clipboardRead();
    assert.equal(rd.dryRun, true);
    assert.deepEqual(rd.command, ['pbpaste']);
    const s = await macos.say('Hello "world"');
    assert.equal(s.script, 'say "Hello \\"world\\""');
  });
});

// ---------- opt-in live checks ----------
test('LIVE: real macOS notification (CAIRN_LIVE_MAC=1)', { skip: process.env.CAIRN_LIVE_MAC !== '1' || process.platform !== 'darwin' }, async () => {
  const prev = process.env.CAIRN_MAC_DRYRUN;
  delete process.env.CAIRN_MAC_DRYRUN;
  try {
    const r = await macos.notify({ title: 'Cairn', message: 'Assistant tools smoke test' });
    assert.equal(r.ok, true, r.error);
    assert.ok(!r.dryRun);
  } finally {
    process.env.CAIRN_MAC_DRYRUN = prev;
  }
});

test('LIVE: claude --permission-prompt-tool calls approval_prompt (CAIRN_LIVE_CLAUDE=1)', { skip: process.env.CAIRN_LIVE_CLAUDE !== '1', timeout: 240_000 }, async () => {
  const api = await startFakeApi();
  api.state.decide = () => ({ allow: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-live-perm-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const cfgFile = path.join(tmp, 'mcp.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { assistant: { command: process.execPath, args: [SERVER], env: { CAIRN_API: api.url, CAIRN_CONVERSATION_ID: 'conv-live', CAIRN_RUN_ID: 'run-live' } } } }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$|^CLAUDE_AGENT_SDK|^CLAUDE_EFFORT$/.test(k)) delete env[k];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', cfgFile, '--permission-prompt-tool', 'mcp__assistant__approval_prompt', '--max-budget-usd', '0.5'];
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.env.CAIRN_CLAUDE_BIN || 'claude', args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let o = '';
      child.stdout.on('data', (d) => (o += d));
      child.on('error', reject);
      child.on('close', () => resolve(o));
      // A bare `echo` is auto-allowed by Claude Code as read-only (no permission prompt),
      // so use a command that writes a file.
      child.stdin.end('Run this exact shell command (it creates a file in the current directory): touch cairn-ok.txt && echo cairn-ok');
    });
    const reqs = api.state.requests.filter((r) => r.method === 'POST' && r.url === '/api/assistant/approvals');
    assert.ok(reqs.length >= 1, 'the CLI invoked the permission prompt tool');
    assert.equal(reqs[0].body.toolName, 'Bash');
    assert.match(reqs[0].body.input.command, /touch cairn-ok\.txt/);
    assert.match(reqs[0].body.toolUseId || '', /^toolu_/);
    assert.ok(fs.existsSync(path.join(work, 'cairn-ok.txt')), 'the approved command ran');
    assert.match(out, /cairn-ok/);
  } finally {
    api.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
