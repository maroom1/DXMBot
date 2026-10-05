#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by assistant tests. Mimics
// `claude -p --output-format stream-json --verbose [--resume <id>] ...`.
//
// Env:
//   FAKE_CLAUDE_MODE   (default) answer | error | slow | resume-fail
//                      resume-fail: when --resume is present, fail exactly like the real CLI
//                      ("No conversation found with session ID", result is_error, exit 1).
//   FAKE_TOOL=1        emit a tool_use + tool_result before the answer
//   FAKE_SLOW_MS       delay for slow mode (default 60000)
//   FAKE_DELAY_MS      delay between stream lines (default 5)
//   FAKE_CLAUDE_RECORD <file> — append one NDJSON line per invocation: {argv, stdin, cwd, mcpConfig, env}
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('9.9.9 (Fake Claude Code)\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'answer';
const delay = Number(process.env.FAKE_DELAY_MS ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : undefined;
};

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  main().catch((e) => {
    process.stderr.write(`fake-claude-assistant crashed: ${e.stack}\n`);
    process.exit(2);
  });
});

async function main() {
  const mcpFile = argValue('--mcp-config');
  let mcpConfig = null;
  if (mcpFile) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    } catch {
      mcpConfig = { unreadable: mcpFile };
    }
  }
  if (process.env.FAKE_CLAUDE_RECORD) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      mcpConfig,
      env: { CLAUDECODE: process.env.CLAUDECODE ?? null, CAIRN_API: process.env.CAIRN_API ?? null },
    }) + '\n');
  }
  const model = argValue('--model') || 'claude-fake';
  const resumeId = argValue('--resume') || null;

  if (resumeId && mode === 'resume-fail') {
    const msg = `No conversation found with session ID: ${resumeId}`;
    process.stderr.write(msg + '\n');
    out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, is_error: true, num_turns: 0, session_id: resumeId, total_cost_usd: 0, errors: [msg] });
    process.exit(1);
  }

  const sessionId = resumeId || crypto.randomUUID();
  const servers = mcpConfig?.mcpServers ? Object.keys(mcpConfig.mcpServers).map((name) => ({ name, status: 'connected' })) : [];
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), tools: ['Read', 'Bash', 'WebSearch'], mcp_servers: servers, permissionMode: 'default' });
  await sleep(delay);

  if (mode === 'slow') {
    await sleep(Number(process.env.FAKE_SLOW_MS || 60_000));
  }

  if (mode === 'error') {
    process.stderr.write('fake-claude-assistant: simulated API failure\n');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: simulated failure', total_cost_usd: 0, duration_ms: 12, num_turns: 1, session_id: sessionId });
    process.exit(1);
  }

  const said = stdin.trim().split('\n').pop().slice(0, 200);
  if (process.env.FAKE_TOOL === '1') {
    const input = { title: 'Stretch', when: '2026-10-01T09:00:00-05:00', kind: 'reminder' };
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me schedule that.' }, { type: 'tool_use', id: 'toolu_fake_1', name: 'mcp__assistant__schedule_task', input }] }, session_id: sessionId });
    await sleep(delay);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: [{ type: 'text', text: 'Scheduled "Stretch" for 2026-10-01T09:00:00-05:00 (task t-1)' }] }] }, session_id: sessionId });
    await sleep(delay);
  }

  const answer = `Hello from fake Claude. You said: ${said}${resumeId ? ` (resumed ${resumeId})` : ''}`;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, session_id: sessionId });
  await sleep(delay);
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.0021, duration_ms: 321, num_turns: process.env.FAKE_TOOL === '1' ? 2 : 1, session_id: sessionId });
  process.exit(0);
}
