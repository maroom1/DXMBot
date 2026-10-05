// Live test against the real Claude Code CLI. Costs real money (cents), so it
// only runs when explicitly requested:
//   CAIRN_LIVE_CLAUDE=1 node --test test/live-claude.test.js
// Optional: CAIRN_CLAUDE_BIN (defaults to `claude`), CAIRN_MODEL (defaults to config.agent.model).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.env.CAIRN_LIVE_CLAUDE === '1';
const QUESTION = 'How much does the Ridgeback 45 weigh and what is the return window?';
const TIMEOUT_MS = 240_000;

// Print what Claude actually said so a green run is also a readable report.
function report(t, res) {
  t.diagnostic(`answer: ${String(res.answer || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  t.diagnostic(`citations: ${JSON.stringify((res.citations || []).map((c) => [c.n, c.url]))}`);
  t.diagnostic(`costUsd: ${res.costUsd ?? 'n/a'} · elapsedMs: ${res.elapsedMs ?? 'n/a'} · model: ${res.model ?? 'n/a'}`);
  if (res.steps) t.diagnostic(`steps: ${res.steps.filter((s) => s.type === 'tool').map((s) => s.name).join(', ') || 'none'}`);
}

function assertGoodAnswer(res, siteUrl) {
  assert.equal(res.usedClaude, true, `Claude was not used (answer: ${res.answer})`);
  assert.match(res.answer, /1\.2/, `answer should state the 1.2 kg weight: ${res.answer}`);
  assert.match(res.answer, /\b60\b/, `answer should state the 60-day return window: ${res.answer}`);
  assert.ok(res.citations.length >= 1, 'at least one citation');
  assert.ok(res.citations.some((c) => c.url.startsWith(siteUrl)), `citations should point at the fixture: ${JSON.stringify(res.citations)}`);
}

describe('live Claude CLI', { skip: LIVE ? false : 'set CAIRN_LIVE_CLAUDE=1 to run (uses the real Claude CLI)', timeout: 3 * TIMEOUT_MS }, () => {
  let tmp;
  let runtime;
  let site;
  let server;

  before(async () => {
    const [{ createRuntime }, { startServer }, { startFixtureSite }] = await Promise.all([
      import('../src/runtime.js'),
      import('../src/server/app.js'),
      import('../fixtures/site-server.js'),
    ]);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-live-'));
    site = await startFixtureSite();
    runtime = await createRuntime({
      dataDir: tmp,
      politeness: { minDelayMs: 0, backoffBaseMs: 10, maxBackoffMs: 100 },
      fetch: { timeoutMs: 5000 },
      agent: { timeoutMs: TIMEOUT_MS },
    });
    const job = runtime.jobs.create({ seeds: [site.url + '/'], role: 'search', maxPages: 60, maxDepth: 6 });
    const status = await runtime.jobs.waitFor(job.id ?? job.status().id, 90_000);
    assert.equal(status.state, 'done');
    assert.ok(runtime.index.has(site.url + '/products/ridgeback-45.html'), 'fixture crawl must index the Ridgeback page');
    server = await startServer({ runtime, port: 0 });
  });

  after(async () => {
    if (server) {
      const closing = server.close();
      server.server?.closeAllConnections?.();
      await closing;
    }
    if (runtime) await runtime.close();
    if (site) await site.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('quick answer (RAG over the index) cites the fixture', { timeout: TIMEOUT_MS + 30_000 }, async (t) => {
    const { claudeAvailable } = await import('../src/agent/claude.js');
    const avail = await claudeAvailable(runtime.config);
    assert.ok(avail.available, `Claude CLI unavailable: ${avail.error}`);

    const { answerQuestion } = await import('../src/agent/answer.js');
    const res = await answerQuestion(QUESTION, { runtime });
    report(t, res);
    assert.equal(res.mode, 'quick');
    assertGoodAnswer(res, site.url);
  });

  it('deep research (Claude CLI + Cairn MCP server) cites the fixture', { timeout: TIMEOUT_MS + 30_000 }, async (t) => {
    const { deepResearch } = await import('../src/agent/research.js');
    const steps = [];
    const res = await deepResearch(QUESTION, { runtime, apiUrl: server.url, onEvent: (e) => steps.push(e) });
    report(t, res);
    assert.equal(res.mode, 'deep');
    assertGoodAnswer(res, site.url);
    assert.ok(res.steps.some((s) => /mcp__cairn__|search_index|fetch_page/.test(`${s.name ?? ''} ${s.type ?? ''}`)), 'the agent used at least one Cairn tool');
  });
});
