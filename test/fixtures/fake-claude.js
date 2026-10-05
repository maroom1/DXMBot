#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by tests. Mimics `claude -p --output-format stream-json`.
// FAKE_CLAUDE_MODE: (default) answer citing [1] | error | slow | garbage | research
// FAKE_CLAUDE_RECORD=<file>: write {argv, stdin, cwd, mcpConfig} as JSON for assertions.
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('9.9.9 (Fake Claude Code)\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'answer';
const sessionId = '00000000-fake-4000-8000-000000000001';
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
process.stdin.on('end', main);

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
    fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, cwd: process.cwd(), mcpConfig, env: { CLAUDECODE: process.env.CLAUDECODE ?? null } }));
  }
  const model = argValue('--model') || 'claude-fake';

  if (mode === 'garbage') {
    process.stdout.write('this is not json\n{"half": \n<html>oops</html>\n');
    process.exit(0);
  }

  out({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: mcpConfig ? Object.keys(mcpConfig.mcpServers || {}).map((name) => ({ name, status: 'connected' })) : [] });

  if (mode === 'slow') {
    await new Promise((r) => setTimeout(r, 60_000));
  }

  if (mode === 'error') {
    process.stderr.write('fake-claude: simulated API failure\n');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: simulated failure', total_cost_usd: 0, duration_ms: 12, num_turns: 1, session_id: sessionId });
    process.exit(1);
  }

  let answer;
  if (mode === 'research') {
    // Pretend the MCP server surfaced two sources, then answer citing only [2].
    const env = mcpConfig?.mcpServers?.cairn?.env || {};
    if (env.CAIRN_SOURCES_FILE) {
      fs.writeFileSync(env.CAIRN_SOURCES_FILE, JSON.stringify([
        { n: 1, url: 'http://example.test/a', title: 'Page A' },
        { n: 2, url: 'http://example.test/b', title: 'Page B' },
      ]));
    }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__cairn__search_index', input: { query: 'ridgeback weight' } }] }, session_id: sessionId });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '[1] Page A\n[2] Page B' }] }] }, session_id: sessionId });
    answer = 'The Ridgeback 45 weighs 1.2 kg [2].';
  } else {
    const m = stdin.match(/^\[(\d+)\]\s*(.+)$/m);
    answer = m ? `According to "${m[2].trim()}", here is the answer [${m[1]}].` : 'I could not find the answer in the sources.';
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, session_id: sessionId });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, total_cost_usd: 0.0012, duration_ms: 345, num_turns: mode === 'research' ? 2 : 1, session_id: sessionId });
  process.exit(0);
}
