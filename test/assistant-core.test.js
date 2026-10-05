// Tests for the assistant core: ConversationStore, ApprovalQueue, AssistantAgent
// (driven by test/fixtures/fake-claude-assistant.js — never the real CLI).
process.env.CAIRN_MAC_DRYRUN = '1';

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationStore } from '../src/assistant/conversations.js';
import { ApprovalQueue, summarizeToolCall, TIMEOUT_MESSAGE } from '../src/assistant/approvals.js';
import { AssistantAgent, buildAllowedTools, buildSystemPrompt, buildArgs, PERMISSION_PROMPT_TOOL, DEFAULT_WORKDIR, resolveWorkDir } from '../src/assistant/agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude-assistant.js');
const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-assistant-core-'));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref())]);

async function until(fn, ms = 5000, what = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const argOf = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

// Builds an agent against the fake CLI. `env` goes to the fake (FAKE_CLAUDE_MODE etc).
function setup({ settings = {}, env = {}, approvalsTimeoutMs } = {}) {
  const dir = mkTmp();
  const record = path.join(dir, 'record.ndjson');
  const audit = [];
  const runtime = {
    config: { dataDir: dir, publicBaseUrl: 'http://127.0.0.1:59999', agent: { claudeBin: FAKE, model: 'sonnet', maxBudgetUsd: 1.5 } },
    audit: { record: (e) => audit.push(e) },
  };
  const conversations = new ConversationStore({ dir: path.join(dir, 'conversations') });
  const approvals = new ApprovalQueue(approvalsTimeoutMs ? { timeoutMs: approvalsTimeoutMs } : {});
  const agentSettings = { model: 'haiku', maxBudgetUsd: 0.5, workDir: dir, allowBrowser: false, autoApproveBrowser: false, maxConcurrentRuns: 3, ...settings };
  const agent = new AssistantAgent({
    runtime,
    conversations,
    approvals,
    getApiUrl: () => runtime.config.publicBaseUrl,
    settings: agentSettings,
    env: { FAKE_CLAUDE_RECORD: record, FAKE_DELAY_MS: '2', ...env },
    // mcp-tools.js may not exist yet in this checkout; any existing file enables the assistant server config.
    paths: { mcpTools: FAKE },
  });
  return { dir, record, audit, runtime, conversations, approvals, agent, settings: agentSettings };
}

function collect(agent, runId) {
  const events = [];
  const done = new Promise((resolve) => {
    agent.subscribe(runId, (e) => {
      events.push(e);
      if (e.type === 'done') resolve(events);
    });
  });
  return { events, done: withTimeout(done, 15000, `run ${runId} done`) };
}

// ---------------------------------------------------------------------------

describe('ConversationStore', () => {
  test('create / append / get / list / setSession / allowAlways / remove + persistence', async () => {
    const dir = path.join(mkTmp(), 'convs');
    const store = new ConversationStore({ dir });
    const a = store.create({ title: 'First conversation about reminders and a very long title that goes past sixty chars' });
    assert.match(a.id, /^[A-Za-z0-9_-]+$/);
    assert.ok(a.title.length <= 60, 'title capped at 60 chars');
    assert.equal(a.sessionId, null);
    assert.deepEqual(a.allowAlways, []);
    assert.deepEqual(a.messages, []);

    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ title: 'Second' });
    const m = store.append(a.id, { role: 'user', text: 'remind me to stretch' });
    assert.ok(m.id && m.ts);
    assert.equal(m.role, 'user');
    store.append(a.id, { role: 'assistant', text: 'Done', costUsd: 0.01, events: [{ type: 'tool', name: 'x' }] });

    const list = store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id, 'most recently updated first');
    assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'messageCount', 'title', 'updatedAt']);
    assert.equal(list[0].messageCount, 2);
    assert.equal(list[1].messageCount, 0);

    assert.equal(store.setSession(a.id, 'sess-1'), true);
    assert.equal(store.addAllowAlways(a.id, 'Bash'), true);
    store.addAllowAlways(a.id, 'Bash');

    // Reload from disk in a fresh store.
    const again = new ConversationStore({ dir });
    const a2 = again.get(a.id);
    assert.equal(a2.sessionId, 'sess-1');
    assert.deepEqual(a2.allowAlways, ['Bash']);
    assert.equal(a2.messages.length, 2);
    assert.equal(a2.messages[1].costUsd, 0.01);
    assert.equal(again.list().length, 2);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');

    // get() returns copies
    a2.messages.push({ role: 'user', text: 'mutated' });
    assert.equal(again.get(a.id).messages.length, 2);

    assert.equal(again.get('../../etc/passwd'), null);
    assert.equal(again.append('nope', { text: 'x' }), null);
    assert.equal(again.remove(b.id), true);
    assert.equal(again.get(b.id), null);
    assert.equal(fs.existsSync(path.join(dir, `${b.id}.json`)), false);
    assert.equal(again.remove(b.id), false);
    assert.equal(again.list().length, 1);
  });
});

describe('ApprovalQueue', () => {
  test('request → pending (with summary) → resolve; double resolve is false; events fire', async () => {
    const q = new ApprovalQueue();
    const seen = [];
    q.on('request', (a) => seen.push(['request', a.id]));
    q.on('resolved', (a) => seen.push(['resolved', a.id, a.decision.allow]));
    const { id, promise } = q.request({ toolName: 'Bash', input: { command: 'ls -la ~/Downloads' }, conversationId: 'c1', runId: 'r1' });
    const pending = q.pending();
    assert.equal(pending.length, 1);
    assert.deepEqual(Object.keys(pending[0]).sort(), ['conversationId', 'createdAt', 'id', 'input', 'runId', 'summary', 'toolName']);
    assert.equal(pending[0].summary, 'Run shell command: ls -la ~/Downloads');
    assert.equal(q.get(id).status, 'pending');

    const waiting = q.wait(id, 5000);
    assert.equal(q.resolve(id, { allow: true, always: true }), true);
    assert.deepEqual(await promise, { allow: true, always: true });
    assert.deepEqual(await waiting, { decided: true, decision: { allow: true, always: true } });
    assert.equal(q.resolve(id, { allow: false }), false);
    assert.equal(q.pending().length, 0);
    assert.equal(q.get(id).status, 'resolved');
    assert.deepEqual(seen, [['request', id], ['resolved', id, true]]);
    assert.equal(q.resolve('missing', { allow: true }), false);
    assert.equal(await q.wait('missing'), null);
  });

  test('deny carries a message; wait long-poll times out undecided; request timeout denies', async () => {
    const q = new ApprovalQueue({ timeoutMs: 60 });
    const a = q.request({ toolName: 'Write', input: { file_path: '/tmp/x.txt', content: 'hi' } });
    assert.deepEqual(await q.wait(a.id, 10), { decided: false });
    const d = await a.promise;
    assert.deepEqual(d, { allow: false, message: TIMEOUT_MESSAGE });
    assert.equal(TIMEOUT_MESSAGE, 'No response from user (timed out)');
    assert.equal(q.get(a.id).status, 'timeout');

    const q2 = new ApprovalQueue();
    const b = q2.request({ toolName: 'Bash', input: { command: 'rm -rf ~/tmp' }, runId: 'r9' });
    q2.resolve(b.id, { allow: false });
    assert.equal((await b.promise).allow, false);
    assert.ok((await b.promise).message);
    const c = q2.request({ toolName: 'Bash', input: { command: 'x' }, runId: 'r9' });
    assert.equal(q2.denyRun('r9'), 1);
    assert.equal((await c.promise).allow, false);

    // Auto-deciders settle before 'request' is emitted.
    let requests = 0;
    q2.on('request', () => requests++);
    const remove = q2.addAutoDecider((a) => (a.toolName === 'Read' ? { allow: true } : null));
    assert.deepEqual(await q2.request({ toolName: 'Read', input: { file_path: '/a' } }).promise, { allow: true });
    assert.equal(requests, 0);
    remove();
    const e = q2.request({ toolName: 'Read', input: { file_path: '/b' } });
    assert.equal(requests, 1);
    q2.close();
    assert.equal((await e.promise).allow, false);
  });

  test('summary strings are one-line and human readable', () => {
    const cases = [
      ['Bash', { command: 'ls -la ~/Downloads' }, 'Run shell command: ls -la ~/Downloads'],
      ['Bash', { command: 'echo a\n echo b' }, 'Run shell command: echo a echo b'],
      ['mcp__playwright__browser_click', { element: 'Add to cart', ref: 'e12' }, 'Click "Add to cart" in browser'],
      ['mcp__playwright__browser_type', { element: 'Search box', text: 'usb-c hub' }, 'Type "usb-c hub" into "Search box" in browser'],
      ['mcp__assistant__clipboard_read', {}, 'Read your clipboard'],
      ['Write', { file_path: '/Users/me/notes.md', content: '...' }, 'Write file: /Users/me/notes.md'],
      ['Edit', { file_path: '/a/b.js' }, 'Edit file: /a/b.js'],
      ['mcp__assistant__open_app', { name: 'Safari' }, 'Open app: Safari'],
      ['mcp__cairn__crawl_site', { url: 'https://example.com' }, 'Crawl site: https://example.com'],
    ];
    for (const [tool, input, expected] of cases) assert.equal(summarizeToolCall(tool, input), expected);
    const long = summarizeToolCall('Bash', { command: 'x'.repeat(1000) });
    assert.ok(long.length < 260 && !long.includes('\n'));
    assert.match(summarizeToolCall('mcp__foo__do_thing', { a: 1 }), /^Use foo tool do thing: \{"a":1\}$/);
  });
});

describe('AssistantAgent', () => {
  test('run → status/text/result/done events, assistant message saved, session reused via --resume', async () => {
    const { agent, conversations, record, audit } = setup();
    const { runId, conversationId } = agent.startRun({ message: 'Remember the word PELICAN please' });
    assert.match(runId, /^run-/);
    const { done } = collect(agent, runId);
    const events = await done;
    const types = events.map((e) => e.type);
    assert.ok(types.includes('status'));
    assert.ok(types.includes('text'));
    assert.ok(types.includes('result'));
    assert.equal(types.at(-1), 'done');
    const result = events.find((e) => e.type === 'result');
    assert.match(result.text, /You said: Remember the word PELICAN please/);
    assert.equal(result.costUsd, 0.0021);
    assert.ok(result.sessionId);
    assert.equal(agent.getRun(runId).state, 'done');

    const conv = conversations.get(conversationId);
    assert.equal(conv.title, 'Remember the word PELICAN please');
    assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(conv.messages[1].costUsd, 0.0021);
    assert.equal(conv.sessionId, result.sessionId);

    // Second message continues the same Claude session.
    const second = agent.startRun({ conversationId, message: 'What word did I say?' });
    assert.equal(second.conversationId, conversationId);
    const ev2 = await collect(agent, second.runId).done;
    const res2 = ev2.find((e) => e.type === 'result');
    assert.match(res2.text, new RegExp(`resumed ${result.sessionId}`));
    const recs = readRecords(record);
    assert.equal(recs.length, 2);
    assert.equal(argOf(recs[0].argv, '--resume'), undefined);
    assert.equal(argOf(recs[1].argv, '--resume'), result.sessionId);
    assert.equal(recs[1].stdin, 'What word did I say?');
    assert.equal(recs[0].env.CLAUDECODE, null, 'enclosing Claude Code session env is stripped');
    assert.equal(conversations.get(conversationId).messages.length, 4);

    assert.equal(audit.length, 2);
    assert.equal(audit[0].kind, 'agent');
    assert.equal(audit[0].mode, 'assistant');
    assert.equal(audit[0].ok, true);
    assert.equal(audit[1].resumed, true);
    agent.stop();
  });

  test('tool events carry names and summaries; steps stored with the assistant message', async () => {
    const { agent, conversations } = setup({ env: { FAKE_TOOL: '1' } });
    const { runId, conversationId } = agent.startRun({ message: 'remind me to stretch tomorrow at 9' });
    const events = await collect(agent, runId).done;
    const tool = events.find((e) => e.type === 'tool');
    assert.equal(tool.name, 'mcp__assistant__schedule_task');
    assert.equal(tool.id, 'toolu_fake_1');
    assert.equal(tool.input.title, 'Stretch');
    const tr = events.find((e) => e.type === 'tool_result');
    assert.equal(tr.id, 'toolu_fake_1');
    assert.equal(tr.name, 'mcp__assistant__schedule_task');
    assert.equal(tr.isError, false);
    assert.match(tr.summary, /Scheduled "Stretch"/);
    const msg = conversations.get(conversationId).messages[1];
    assert.ok(msg.events.some((e) => e.type === 'tool' && e.name === 'mcp__assistant__schedule_task'));
    // Multi-block turn: the saved answer / result keeps text written before the tool call (CLI `result` is only the last block).
    assert.match(msg.text, /^Let me schedule that\.\n\nHello from fake Claude/);
    assert.equal(events.find((e) => e.type === 'result').text, msg.text);
    agent.stop();
  });

  test('safety defaults: isolated Claude settings, ~/CairnWorkspace-style cwd with home via --add-dir', async () => {
    const { agent, record, settings } = setup();
    const { runId } = agent.startRun({ message: 'hi' });
    await agent.waitForRun(runId);
    let argv = readRecords(record)[0].argv;
    assert.equal(argOf(argv, '--setting-sources'), '', 'isolated by default (user allow rules must not bypass approvals)');
    assert.equal(argOf(argv, '--add-dir'), os.homedir());
    settings.isolateClaudeSettings = false;
    const r2 = agent.startRun({ message: 'again' });
    await agent.waitForRun(r2.runId);
    argv = readRecords(record)[1].argv;
    assert.ok(!argv.includes('--setting-sources'), 'explicit opt-out');
    assert.equal(DEFAULT_WORKDIR, path.join(os.homedir(), 'CairnWorkspace'));
    assert.equal(resolveWorkDir(path.join(os.tmpdir(), 'definitely-missing-cairn-dir')), os.homedir());
    assert.ok(buildSystemPrompt({ workDir: DEFAULT_WORKDIR }).includes(DEFAULT_WORKDIR));
    const a = buildArgs({ model: 'haiku', addDirs: ['/Users/x'] });
    assert.equal(a[a.indexOf('--add-dir') + 1], '/Users/x');
    agent.stop();
  });

  test('--resume failure retries once without --resume and stores the new session', async () => {
    const { agent, conversations, record } = setup({ env: { FAKE_CLAUDE_MODE: 'resume-fail' } });
    const conv = conversations.create({ title: 'old chat' });
    conversations.append(conv.id, { role: 'user', text: 'My favourite colour is teal' });
    conversations.append(conv.id, { role: 'assistant', text: 'Noted: teal.' });
    conversations.setSession(conv.id, 'stale-session-id');
    const { runId } = agent.startRun({ conversationId: conv.id, message: 'What is my favourite colour?' });
    const events = await collect(agent, runId).done;
    assert.equal(agent.getRun(runId).state, 'done');
    assert.ok(events.some((e) => e.type === 'status' && /could not be resumed/.test(e.message)));
    assert.ok(!events.some((e) => e.type === 'error'), 'first failed attempt is not surfaced as an error');
    const recs = readRecords(record);
    assert.equal(recs.length, 2);
    assert.equal(argOf(recs[0].argv, '--resume'), 'stale-session-id');
    assert.equal(recs[1].argv.includes('--resume'), false);
    assert.match(recs[1].stdin, /favourite colour is teal/, 'fresh session gets the recent transcript');
    assert.match(recs[1].stdin, /What is my favourite colour\?$/);
    const sid = conversations.get(conv.id).sessionId;
    assert.ok(sid && sid !== 'stale-session-id');
    agent.stop();
  });

  test('CLI error → error event, state error, system message saved, session untouched', async () => {
    const { agent, conversations, audit } = setup({ env: { FAKE_CLAUDE_MODE: 'error' } });
    const { runId, conversationId } = agent.startRun({ message: 'hello' });
    const events = await collect(agent, runId).done;
    const err = events.find((e) => e.type === 'error');
    assert.match(err.message, /simulated failure/);
    assert.equal(agent.getRun(runId).state, 'error');
    const conv = conversations.get(conversationId);
    assert.equal(conv.messages.at(-1).role, 'system');
    assert.match(conv.messages.at(-1).text, /Run failed/);
    assert.equal(audit[0].ok, false);
    assert.ok(audit[0].error);
    agent.stop();
  });

  test('missing CLI binary → error run, never throws', async () => {
    const { agent, runtime } = setup();
    runtime.config.agent.claudeBin = path.join(os.tmpdir(), 'definitely-not-claude-xyz');
    const { runId } = agent.startRun({ message: 'hi' });
    const events = await collect(agent, runId).done;
    assert.match(events.find((e) => e.type === 'error').message, /not found/);
    agent.stop();
  });

  test('concurrency cap: 4th run queues, starts when a slot frees; cancel running + queued', async () => {
    const { agent, record } = setup({ env: { FAKE_CLAUDE_MODE: 'slow', FAKE_SLOW_MS: '30000' }, settings: { maxConcurrentRuns: 3 } });
    const updates = [];
    agent.on('run_update', (r) => updates.push([r.runId, r.state]));
    const started = [];
    agent.on('run_started', (r) => started.push(r.runId));
    const runs = [1, 2, 3, 4, 5].map((n) => agent.startRun({ message: `background task ${n}` }));
    assert.equal(started.length, 5);
    const states = () => runs.map((r) => agent.getRun(r.runId).state);
    assert.deepEqual(states(), ['running', 'running', 'running', 'queued', 'queued']);
    assert.equal(agent.counts().runningRuns, 3);
    assert.equal(agent.counts().queuedRuns, 2);
    assert.ok(agent.getRun(runs[3].runId).events.some((e) => e.type === 'status' && /Queued/.test(e.message)));
    await until(() => readRecords(record).length === 3, 5000, '3 CLI processes');

    // Cancel a queued run: never spawns.
    assert.equal(agent.cancel(runs[4].runId), true);
    assert.equal(agent.getRun(runs[4].runId).state, 'cancelled');
    assert.equal(agent.getRun(runs[4].runId).events.at(-1).type, 'done');

    // Cancel a running one → the queued 4th starts.
    const c0 = collect(agent, runs[0].runId);
    assert.equal(agent.cancel(runs[0].runId), true);
    await c0.done;
    assert.equal(agent.getRun(runs[0].runId).state, 'cancelled');
    await until(() => agent.getRun(runs[3].runId).state === 'running', 5000, '4th run to start');
    await until(() => readRecords(record).length === 4, 5000, '4th CLI process');
    assert.equal(agent.cancel(runs[0].runId), false, 'already finished');

    const rest = [1, 2, 3].map((i) => collect(agent, runs[i].runId).done);
    for (const i of [1, 2, 3]) agent.cancel(runs[i].runId);
    await Promise.all(rest);
    assert.deepEqual(states(), ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
    assert.ok(updates.some(([id, s]) => id === runs[3].runId && s === 'running'));
    assert.equal(readRecords(record).length, 4, 'cancelled queued run never spawned');
    agent.stop();
  });

  test('runs in the same conversation are serialized (share one Claude session in order)', async () => {
    const { agent, record } = setup();
    const a = agent.startRun({ message: 'first' });
    const b = agent.startRun({ conversationId: a.conversationId, message: 'second' });
    assert.equal(agent.getRun(b.runId).state, 'queued');
    await agent.waitForRun(b.runId);
    const recs = readRecords(record);
    assert.equal(recs.length, 2);
    assert.equal(recs[1].argv.includes('--resume'), true, 'second run resumes the first run session');
    agent.stop();
  });

  test('approval for a run → waiting_approval, forwarded events, always-allow saved on conversation', async () => {
    const { agent, approvals, conversations } = setup({ env: { FAKE_CLAUDE_MODE: 'slow', FAKE_SLOW_MS: '30000' } });
    const { runId, conversationId } = agent.startRun({ message: 'organize my Downloads' });
    const seen = [];
    agent.subscribe(runId, (e) => seen.push(e));
    const { id, promise } = approvals.request({ toolName: 'Bash', input: { command: 'mkdir ~/Downloads/PDFs' }, conversationId, runId });
    assert.equal(agent.getRun(runId).state, 'waiting_approval');
    assert.equal(agent.listRuns()[0].state, 'waiting_approval');
    assert.match(agent.listRuns()[0].lastEvent, /Waiting for approval: Run shell command: mkdir/);
    const apEv = seen.find((e) => e.type === 'approval');
    assert.equal(apEv.approval.id, id);
    assert.equal(apEv.approval.summary, 'Run shell command: mkdir ~/Downloads/PDFs');

    approvals.resolve(id, { allow: true, always: true });
    assert.equal((await promise).allow, true);
    assert.equal(agent.getRun(runId).state, 'running');
    assert.deepEqual(
      seen.filter((e) => e.type === 'approval_resolved').map((e) => [e.id, e.allow]),
      [[id, true]],
    );
    assert.deepEqual(conversations.get(conversationId).allowAlways, ['Bash']);

    // Later approval requests for an always-allowed tool in the same run are auto-approved
    // before any 'request' event (no UI card, no notification) and the run keeps running.
    let requestEvents = 0;
    approvals.on('request', () => requestEvents++);
    const again = approvals.request({ toolName: 'Bash', input: { command: 'mv a b' }, conversationId, runId });
    assert.deepEqual(await withTimeout(again.promise, 2000, 'auto-approval'), { allow: true, updatedInput: { command: 'mv a b' } });
    assert.equal(requestEvents, 0);
    assert.equal(agent.getRun(runId).state, 'running');
    assert.ok(seen.some((e) => e.type === 'status' && /Auto-approved/.test(e.message)));

    // Cancelling a run denies its pending approvals.
    const third = approvals.request({ toolName: 'Write', input: { file_path: '/x' }, conversationId, runId });
    agent.cancel(runId);
    assert.equal((await third.promise).allow, false);
    await agent.waitForRun(runId);
    assert.equal(agent.getRun(runId).state, 'cancelled');
    agent.stop();
  });

  test('subscribe after completion replays every buffered event, then unsubscribes', async () => {
    const { agent } = setup();
    const { runId } = agent.startRun({ message: 'quick one' });
    await agent.waitForRun(runId);
    const replay = [];
    const unsub = agent.subscribe(runId, (e) => replay.push(e));
    assert.equal(typeof unsub, 'function');
    assert.deepEqual(replay.map((e) => e.type), agent.getRun(runId).events.map((e) => e.type));
    assert.equal(replay.at(-1).type, 'done');
    assert.ok(replay.some((e) => e.type === 'text'));
    unsub();
    assert.equal(typeof agent.subscribe('run-nope', () => {}), 'function');
    assert.equal(agent.getRun('run-nope'), null);
    agent.stop();
  });

  test('listRuns shape, newest first, limit; runs.json persisted and interrupted runs recovered', async () => {
    const { agent, runtime, conversations, approvals } = setup();
    const a = agent.startRun({ message: 'alpha task' });
    await agent.waitForRun(a.runId);
    const b = agent.startRun({ message: 'beta task' });
    await agent.waitForRun(b.runId);
    const rows = agent.listRuns();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].runId, b.runId);
    for (const k of ['runId', 'conversationId', 'title', 'state', 'startedAt', 'finishedAt', 'lastEvent', 'costUsd']) assert.ok(k in rows[0], k);
    assert.equal(rows[0].title, 'beta task');
    assert.equal(rows[0].state, 'done');
    assert.equal(rows[0].costUsd, 0.0021);
    assert.equal(typeof rows[0].lastEvent, 'string');
    assert.ok(Date.parse(rows[0].startedAt) <= Date.parse(rows[0].finishedAt));
    assert.equal(agent.listRuns({ limit: 1 }).length, 1);
    agent.stop();

    const file = path.join(runtime.config.dataDir, 'runs.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.length, 2);
    assert.ok(!('events' in saved[0]));
    // Simulate a crash mid-run.
    saved.push({ runId: 'run-crashed', conversationId: a.conversationId, title: 'crashed', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, lastEvent: 'Using Bash', costUsd: null });
    fs.writeFileSync(file, JSON.stringify(saved));
    const agent2 = new AssistantAgent({ runtime, conversations, approvals, getApiUrl: () => 'http://127.0.0.1:1', settings: {} });
    const crashed = agent2.getRun('run-crashed');
    assert.equal(crashed.state, 'error');
    assert.equal(crashed.error, 'interrupted');
    assert.equal(agent2.listRuns()[0].runId, 'run-crashed');
    assert.equal(agent2.listRuns().length, 3);
    const replay = [];
    agent2.subscribe('run-crashed', (e) => replay.push(e.type));
    assert.deepEqual(replay, ['error', 'done']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).find((r) => r.runId === 'run-crashed').state, 'error');
    agent2.stop();
  });

  test('CLI args: permission prompt tool, allowedTools per settings, MCP config env, system prompt, budget', async () => {
    const { agent, record, settings } = setup({ settings: { allowBrowser: true, autoApproveBrowser: false } });
    const { runId, conversationId } = agent.startRun({ message: 'shop for a usb-c hub' });
    await agent.waitForRun(runId);
    let [rec] = readRecords(record);
    const argv = rec.argv;
    assert.deepEqual(argv.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
    assert.equal(argOf(argv, '--model'), 'haiku');
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.equal(argOf(argv, '--permission-prompt-tool'), PERMISSION_PROMPT_TOOL);
    assert.equal(PERMISSION_PROMPT_TOOL, 'mcp__assistant__approval_prompt');
    assert.equal(argOf(argv, '--max-budget-usd'), '0.5');
    assert.match(argOf(argv, '--append-system-prompt'), /Cairn/);
    assert.match(argOf(argv, '--append-system-prompt'), /NEVER enter payment details/);
    assert.equal(rec.cwd, fs.realpathSync(settings.workDir));
    assert.equal(rec.stdin, 'shop for a usb-c hub');

    const allowed = argOf(argv, '--allowedTools').split(',');
    for (const t of ['mcp__assistant__schedule_task', 'mcp__assistant__notify', 'mcp__assistant__shopping_list_add', 'mcp__cairn__search_index',
      'mcp__cairn__fetch_page', 'mcp__cairn__check_robots', 'mcp__cairn__index_stats', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
      'mcp__playwright__browser_navigate', 'mcp__playwright__browser_snapshot', 'mcp__playwright__browser_wait_for']) {
      assert.ok(allowed.includes(t), `${t} auto-approved`);
    }
    for (const t of ['mcp__assistant__clipboard_read', 'mcp__cairn__crawl_site', 'Bash', 'Write', 'Edit', 'mcp__playwright__browser_click', 'mcp__playwright']) {
      assert.ok(!allowed.includes(t), `${t} requires approval`);
    }

    const servers = rec.mcpConfig.mcpServers;
    assert.deepEqual(Object.keys(servers).sort(), ['assistant', 'cairn', 'playwright']);
    assert.equal(servers.assistant.command, process.execPath);
    assert.deepEqual(servers.assistant.env, { CAIRN_API: 'http://127.0.0.1:59999', CAIRN_CONVERSATION_ID: conversationId, CAIRN_RUN_ID: runId, CAIRN_UNATTENDED: '0' });
    assert.match(servers.cairn.args[0], /src\/agent\/mcp-server\.js$/);
    assert.equal(servers.cairn.env.CAIRN_API, 'http://127.0.0.1:59999');
    assert.ok(servers.cairn.env.CAIRN_SOURCES_FILE);
    assert.deepEqual(servers.playwright, { command: 'npx', args: ['-y', '@playwright/mcp@latest'] });

    // autoApproveBrowser on + a conversation allowAlways entry → next run's list.
    settings.autoApproveBrowser = true;
    agent.conversations.addAllowAlways(conversationId, 'Bash');
    const r2 = agent.startRun({ conversationId, message: 'again' });
    await agent.waitForRun(r2.runId);
    rec = readRecords(record)[1];
    const allowed2 = argOf(rec.argv, '--allowedTools').split(',');
    assert.ok(allowed2.includes('mcp__playwright'));
    assert.ok(allowed2.includes('Bash'));

    // Browser disabled → no playwright server and no playwright tools.
    settings.allowBrowser = false;
    const r3 = agent.startRun({ message: 'no browser please' });
    await agent.waitForRun(r3.runId);
    rec = readRecords(record)[2];
    assert.ok(!('playwright' in rec.mcpConfig.mcpServers));
    assert.ok(!argOf(rec.argv, '--allowedTools').includes('playwright'));
    agent.stop();
  });

  test('buildAllowedTools / buildSystemPrompt units', () => {
    const off = buildAllowedTools({ settings: { allowBrowser: true, autoApproveBrowser: false } });
    const on = buildAllowedTools({ settings: { allowBrowser: true, autoApproveBrowser: true }, allowAlways: ['Write', 'Write'] });
    assert.ok(!off.includes('mcp__playwright'));
    assert.ok(on.includes('mcp__playwright'));
    assert.equal(on.filter((t) => t === 'Write').length, 1);
    assert.ok(!off.includes('mcp__assistant__clipboard_read'));
    assert.ok(off.includes('mcp__assistant__clipboard_write'));
    const p = buildSystemPrompt({ unattended: true, now: new Date(2026, 8, 30, 15, 4, 5), settings: { allowBrowser: true } });
    assert.match(p, /2026-09-30T15:04:05[+-]\d\d:\d\d/);
    assert.match(p, /schedule_task/);
    assert.match(p, /UNATTENDED/);
    assert.match(p, /time zone/);
    assert.ok(!/UNATTENDED/.test(buildSystemPrompt({ unattended: false })));

    const plain = buildArgs({ model: 'haiku', allowedTools: ['Read'] });
    assert.ok(!plain.includes('--setting-sources'));
    assert.ok(!plain.includes('--resume'));
    assert.equal(plain[plain.indexOf('--permission-prompt-tool') + 1], 'mcp__assistant__approval_prompt');
    const iso = buildArgs({ model: 'haiku', isolateSettings: true, resumeSessionId: 's1', maxBudgetUsd: 0 });
    assert.equal(iso[iso.indexOf('--setting-sources') + 1], '');
    assert.equal(iso[iso.indexOf('--resume') + 1], 's1');
    assert.ok(!iso.includes('--max-budget-usd'), 'budget 0 → flag omitted');
  });

  test('runOnce: unattended scheduled run in a "Scheduled: …" conversation', async () => {
    const { agent, conversations, record } = setup();
    const res = await withTimeout(agent.runOnce('Summarize the top tech news'), 15000, 'runOnce');
    assert.equal(res.ok, true);
    assert.match(res.text, /Summarize the top tech news/);
    assert.equal(res.costUsd, 0.0021);
    const conv = conversations.get(res.conversationId);
    assert.equal(conv.title, 'Scheduled: Summarize the top tech news');
    const [rec] = readRecords(record);
    assert.equal(rec.mcpConfig.mcpServers.assistant.env.CAIRN_UNATTENDED, '1');
    assert.match(argOf(rec.argv, '--append-system-prompt'), /UNATTENDED/);
    assert.equal(agent.listRuns()[0].unattended, true);

    const bad = setup({ env: { FAKE_CLAUDE_MODE: 'error' } });
    const r2 = await bad.agent.runOnce('fail please');
    assert.equal(r2.ok, false);
    assert.ok(r2.error);
    agent.stop();
    bad.agent.stop();
  });

  test('startRun validates input and recreates a deleted conversation', async () => {
    const { agent, conversations } = setup();
    assert.throws(() => agent.startRun({ message: '   ' }), /message is required/);
    const { runId, conversationId } = agent.startRun({ conversationId: 'c-deleted-123', message: 'hello again' });
    assert.notEqual(conversationId, 'c-deleted-123');
    assert.ok(conversations.get(conversationId));
    await agent.waitForRun(runId);
    agent.stop();
  });
});
