import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, claudeAvailable, buildClaudeArgs } from '../src/agent/claude.js';
import { answerQuestion, extractCitationNumbers, citationsFor } from '../src/agent/answer.js';
import { deepResearch, MCP_SERVER_PATH } from '../src/agent/research.js';
import { AuditLog } from '../src/util/audit.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.js');

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-agent-test-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(overrides = {}) {
  return {
    dataDir: tmp,
    agent: { claudeBin: FAKE, model: 'haiku', timeoutMs: 15000, maxBudgetUsd: 0.5, maxPassages: 8, ...overrides },
  };
}

const PASSAGES = [
  { url: 'http://shop.test/products/ridgeback-45.html', title: 'Ridgeback 45', text: 'The Ridgeback 45 backpack weighs 1.2 kg. It costs $189 and holds 45 L.', score: 3.2 },
  { url: 'http://shop.test/faq.html', title: 'FAQ', text: 'Returns are accepted within 60 days of purchase. Packs carry a lifetime warranty.', score: 2.1 },
  { url: 'http://shop.test/products/ridgeback-45.html', title: 'Ridgeback 45', text: 'Second passage from the same page about the hip belt.', score: 1.5 },
];

function fakeRuntime({ passages = PASSAGES, config = makeConfig() } = {}) {
  const calls = [];
  return {
    config,
    audit: new AuditLog(),
    calls,
    index: {
      searchPassages(q, opts) {
        calls.push({ q, opts });
        return passages;
      },
      stats: () => ({ docs: passages.length ? 2 : 0, passages: passages.length, terms: 10, sites: [], lastUpdated: null }),
    },
  };
}

describe('claude.js', () => {
  test('buildClaudeArgs produces the documented flag set', () => {
    const args = buildClaudeArgs({ model: 'haiku', builtinTools: '', mcpConfigFile: '/x/mcp.json', allowedTools: ['a', 'b'], systemPrompt: 'Be brief', maxBudgetUsd: 0.25 });
    assert.deepEqual(args, [
      '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--mcp-config', '/x/mcp.json',
      '--allowedTools', 'a,b', '--system-prompt=Be brief', '--max-budget-usd', '0.25', '--permission-prompts', 'none',
    ]);
  });

  test('claudeAvailable reports the fake version and a missing binary', async () => {
    const ok = await claudeAvailable(makeConfig());
    assert.equal(ok.available, true);
    assert.match(ok.version, /9\.9\.9/);
    const missing = await claudeAvailable(makeConfig({ claudeBin: path.join(tmp, 'no-such-claude') }));
    assert.equal(missing.available, false);
    assert.match(missing.error, /not found/i);
  });

  test('runClaude parses stream-json events, passes prompt on stdin and flags in argv', async () => {
    const record = path.join(tmp, 'record-1.json');
    const events = [];
    const res = await runClaude({
      config: makeConfig(),
      prompt: 'Question?\n[1] Some Title\nbody',
      systemPrompt: 'System here',
      mcpConfig: { mcpServers: { cairn: { command: 'node', args: ['x.js'] } } },
      allowedTools: ['mcp__cairn__index_stats'],
      env: { FAKE_CLAUDE_RECORD: record },
      onEvent: (e) => events.push(e),
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.text, /\[1\]/);
    assert.equal(res.costUsd, 0.0012);
    assert.equal(res.numTurns, 1);
    assert.equal(res.durationMs, 345);
    assert.ok(res.sessionId);
    assert.equal(res.isError, false);
    assert.equal(res.raw.type, 'result');

    const types = events.map((e) => e.type);
    assert.ok(types.includes('status'));
    assert.ok(types.includes('text'));
    assert.equal(types.at(-1), 'result');
    const init = events.find((e) => e.stage === 'init');
    assert.equal(init.model, 'haiku');

    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.equal(rec.stdin, 'Question?\n[1] Some Title\nbody');
    assert.equal(rec.cwd, fs.realpathSync(path.join(tmp, 'agent-work')));
    for (const flag of ['-p', '--verbose', '--no-session-persistence', '--strict-mcp-config']) assert.ok(rec.argv.includes(flag), flag);
    assert.equal(rec.argv[rec.argv.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(rec.argv[rec.argv.indexOf('--model') + 1], 'haiku');
    assert.equal(rec.argv[rec.argv.indexOf('--tools') + 1], '');
    assert.equal(rec.argv[rec.argv.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(rec.argv[rec.argv.indexOf('--allowedTools') + 1], 'mcp__cairn__index_stats');
    assert.equal(rec.argv[rec.argv.indexOf('--max-budget-usd') + 1], '0.5');
    assert.ok(rec.argv.includes('--system-prompt=System here'));
    assert.deepEqual(rec.mcpConfig, { mcpServers: { cairn: { command: 'node', args: ['x.js'] } } });
    assert.equal(rec.env.CLAUDECODE, null, 'parent Claude Code session env must not leak');
    // The temporary MCP config file is removed afterwards.
    const mcpFile = rec.argv[rec.argv.indexOf('--mcp-config') + 1];
    assert.equal(fs.existsSync(mcpFile), false);
  });

  test('runClaude kills the CLI on timeout', async () => {
    const t0 = Date.now();
    const res = await runClaude({ config: makeConfig(), prompt: 'hi', timeoutMs: 400, env: { FAKE_CLAUDE_MODE: 'slow' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /timed out/);
    assert.ok(Date.now() - t0 < 5000);
  });

  test('runClaude honours an abort signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const res = await runClaude({ config: makeConfig(), prompt: 'hi', signal: ac.signal, env: { FAKE_CLAUDE_MODE: 'slow' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /aborted/);
  });

  test('runClaude with a nonexistent binary returns ok:false', async () => {
    const res = await runClaude({ config: makeConfig({ claudeBin: path.join(tmp, 'missing-bin') }), prompt: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/i);
    assert.equal(res.text, '');
  });

  test('runClaude surfaces CLI errors and tolerates garbage output', async () => {
    const err = await runClaude({ config: makeConfig(), prompt: 'hi', env: { FAKE_CLAUDE_MODE: 'error' } });
    assert.equal(err.ok, false);
    assert.equal(err.isError, true);
    assert.match(err.error, /simulated failure/);

    const garbage = await runClaude({ config: makeConfig(), prompt: 'hi', env: { FAKE_CLAUDE_MODE: 'garbage' } });
    assert.equal(garbage.ok, false);
    assert.match(garbage.error, /without a result/);
  });
});

describe('citations', () => {
  test('extractCitationNumbers handles lists, ranges and repeats', () => {
    assert.deepEqual(extractCitationNumbers('A [2] b [1][3] c [2, 4] d [5-6] [x] [2]'), [2, 1, 3, 4, 5, 6]);
    const sources = [{ n: 1, url: 'u1', title: 't1' }, { n: 2, url: 'u2', title: 't2' }];
    assert.deepEqual(citationsFor('see [2] and [9] and [1]', sources), [{ n: 1, url: 'u1', title: 't1' }, { n: 2, url: 'u2', title: 't2' }]);
  });
});

describe('answerQuestion', () => {
  test('uses Claude and maps [n] citations to sources', async () => {
    const rt = fakeRuntime();
    const events = [];
    const res = await answerQuestion('How much does the Ridgeback 45 weigh?', { runtime: rt, onEvent: (e) => events.push(e) });
    assert.equal(res.usedClaude, true);
    assert.equal(res.mode, 'quick');
    assert.match(res.answer, /\[1\]/);
    assert.deepEqual(res.citations, [{ n: 1, url: 'http://shop.test/products/ridgeback-45.html', title: 'Ridgeback 45' }]);
    assert.equal(res.costUsd, 0.0012);
    assert.equal(rt.calls[0].opts.limit, 8);
    // Passages from the same URL share one source number.
    assert.deepEqual(res.passages.map((p) => p.n), [1, 2, 1]);
    assert.ok(events.some((e) => e.type === 'retrieval'));
    assert.ok(events.some((e) => e.type === 'text'));
    const entry = rt.audit.recent({ kind: 'agent' })[0];
    assert.equal(entry.mode, 'quick');
    assert.equal(entry.ok, true);
    assert.equal(entry.model, 'haiku');
  });

  test('falls back to an extractive, cited answer when the CLI is missing', async () => {
    const rt = fakeRuntime({ config: makeConfig({ claudeBin: path.join(tmp, 'nope-claude') }) });
    const res = await answerQuestion('What is the return window?', { runtime: rt });
    assert.equal(res.usedClaude, false);
    assert.match(res.answer, /\[1\]/);
    assert.match(res.answer, /\[2\]/);
    assert.match(res.answer, /60 days/);
    assert.deepEqual(res.citations.map((c) => c.n), [1, 2]);
    assert.match(res.note, /not found/i);
    assert.equal(rt.audit.recent({ kind: 'agent' })[0].ok, false);
  });

  test('falls back when Claude fails at runtime', async () => {
    const prev = process.env.FAKE_CLAUDE_MODE;
    process.env.FAKE_CLAUDE_MODE = 'error';
    try {
      const res = await answerQuestion('weight?', { runtime: fakeRuntime() });
      assert.equal(res.usedClaude, false);
      assert.ok(res.citations.length >= 1);
      assert.match(res.note, /simulated failure/);
    } finally {
      if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = prev;
    }
  });

  test('empty index gives a helpful message without calling Claude', async () => {
    const record = path.join(tmp, 'should-not-exist.json');
    process.env.FAKE_CLAUDE_RECORD = record;
    try {
      const res = await answerQuestion('anything?', { runtime: fakeRuntime({ passages: [] }) });
      assert.equal(res.usedClaude, false);
      assert.deepEqual(res.citations, []);
      assert.match(res.answer, /crawl/i);
      assert.equal(fs.existsSync(record), false);
    } finally {
      delete process.env.FAKE_CLAUDE_RECORD;
    }
  });

  test('rejects an empty question', async () => {
    await assert.rejects(answerQuestion('  ', { runtime: fakeRuntime() }), /question is required/);
  });
});

describe('deepResearch', () => {
  test('wires the MCP config and maps cited sources from the sources file', async () => {
    const prevMode = process.env.FAKE_CLAUDE_MODE;
    const record = path.join(tmp, 'record-deep.json');
    process.env.FAKE_CLAUDE_MODE = 'research';
    process.env.FAKE_CLAUDE_RECORD = record;
    try {
      const rt = fakeRuntime();
      const events = [];
      const res = await deepResearch('How heavy is the Ridgeback?', { runtime: rt, apiUrl: 'http://127.0.0.1:9', onEvent: (e) => events.push(e) });
      assert.equal(res.mode, 'deep');
      assert.equal(res.usedClaude, true);
      assert.equal(res.ok, true);
      assert.deepEqual(res.citations, [{ n: 2, url: 'http://example.test/b', title: 'Page B' }]);
      assert.equal(res.steps[0].type, 'tool');
      assert.equal(res.steps[0].name, 'search_index');
      assert.deepEqual(res.steps[0].input, { query: 'ridgeback weight' });
      assert.equal(res.steps[1].type, 'tool_result');
      assert.equal(res.steps[1].name, 'search_index');
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'search_index'));

      const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
      const server = rec.mcpConfig.mcpServers.cairn;
      assert.equal(server.command, process.execPath);
      assert.deepEqual(server.args, [MCP_SERVER_PATH]);
      assert.equal(server.env.CAIRN_API, 'http://127.0.0.1:9');
      assert.ok(server.env.CAIRN_SOURCES_FILE);
      assert.equal(fs.existsSync(server.env.CAIRN_SOURCES_FILE), false, 'scratch dir cleaned up');
      const allowed = rec.argv[rec.argv.indexOf('--allowedTools') + 1].split(',');
      assert.deepEqual(allowed.sort(), ['mcp__cairn__check_robots', 'mcp__cairn__crawl_site', 'mcp__cairn__fetch_page', 'mcp__cairn__index_stats', 'mcp__cairn__search_index']);
      assert.equal(rec.argv[rec.argv.indexOf('--tools') + 1], '');
      assert.equal(rt.audit.recent({ kind: 'agent' })[0].mode, 'deep');
    } finally {
      if (prevMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = prevMode;
      delete process.env.FAKE_CLAUDE_RECORD;
    }
  });

  test('allowLiveFetch:false removes fetch/crawl tools', async () => {
    const record = path.join(tmp, 'record-deep-nolive.json');
    process.env.FAKE_CLAUDE_RECORD = record;
    try {
      await deepResearch('q?', { runtime: fakeRuntime(), apiUrl: 'http://127.0.0.1:9', allowLiveFetch: false });
      const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
      const allowed = rec.argv[rec.argv.indexOf('--allowedTools') + 1].split(',');
      assert.ok(!allowed.includes('mcp__cairn__fetch_page'));
      assert.ok(!allowed.includes('mcp__cairn__crawl_site'));
      assert.equal(rec.mcpConfig.mcpServers.cairn.env.CAIRN_ALLOW_LIVE_FETCH, '0');
    } finally {
      delete process.env.FAKE_CLAUDE_RECORD;
    }
  });

  test('degrades to a quick answer when Claude is unavailable', async () => {
    const rt = fakeRuntime({ config: makeConfig({ claudeBin: path.join(tmp, 'absent-claude') }) });
    const res = await deepResearch('weight?', { runtime: rt, apiUrl: 'http://127.0.0.1:9' });
    assert.equal(res.mode, 'deep');
    assert.equal(res.usedClaude, false);
    assert.deepEqual(res.steps, []);
    assert.ok(res.citations.length >= 1);
  });
});
