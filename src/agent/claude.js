// Thin, dependency-free wrapper around the Claude Code CLI in print mode.
// We spawn `claude -p --output-format stream-json`, feed the prompt on stdin
// and translate the NDJSON event stream into a small set of normalized events.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION_CACHE_MS = 60_000;
const versionCache = new Map(); // bin -> { at, value }

// Env vars that tie a process to an enclosing Claude Code session. A Cairn
// agent run is an independent session, so these must not leak into it.
const SESSION_LINK_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SESSION_LINK_ENV) delete env[k];
  return { ...env, ...extra };
}

// A relative path like `test/fixtures/fake-claude.js` would otherwise be resolved
// against the child's cwd (agent-work); bare names are still looked up on PATH.
function resolveBin(bin) {
  return bin.includes('/') && !path.isAbsolute(bin) ? path.resolve(bin) : bin;
}

export async function claudeAvailable(config) {
  const bin = resolveBin(config?.agent?.claudeBin || 'claude');
  const cached = versionCache.get(bin);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.value;
  const value = await probeVersion(bin);
  versionCache.set(bin, { at: Date.now(), value });
  return value;
}

function probeVersion(bin) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      return done({ available: false, version: null, bin, error: e.message });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ available: false, version: null, bin, error: 'timed out running --version' });
    }, 15_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ available: false, version: null, bin, error: spawnErrorMessage(e, bin) }));
    child.on('close', (code) => {
      if (code === 0) done({ available: true, version: out.trim().split('\n')[0] || null, bin });
      else done({ available: false, version: null, bin, error: (err || out).trim().slice(0, 300) || `exit code ${code}` });
    });
  });
}

function spawnErrorMessage(e, bin) {
  if (e.code === 'ENOENT') return `Claude CLI not found ("${bin}"). Install Claude Code or set agent.claudeBin / CAIRN_CLAUDE_BIN.`;
  if (e.code === 'EACCES') return `Claude CLI "${bin}" is not executable.`;
  return e.message;
}

export function buildClaudeArgs({ model, builtinTools = '', mcpConfigFile, allowedTools = [], systemPrompt, maxBudgetUsd, jsonSchema }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  if (model) args.push('--model', model);
  // --tools is variadic; the empty string disables every built-in tool (MCP tools stay available).
  args.push('--tools', builtinTools ?? '');
  args.push('--strict-mcp-config');
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
  if (allowedTools && allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  // `--opt=value` form so text beginning with "-" is never parsed as a flag.
  if (systemPrompt) args.push(`--system-prompt=${systemPrompt}`);
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null && Number(maxBudgetUsd) > 0) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  if (jsonSchema) args.push(`--json-schema=${typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema)}`);
  args.push('--permission-prompts', 'none');
  return args;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Translate one stream-json message into zero or more normalized events.
export function normalizeMessage(msg) {
  const events = [];
  if (!msg || typeof msg !== 'object') return events;
  if (msg.type === 'system') {
    if (msg.subtype === 'init') {
      events.push({
        type: 'status',
        stage: 'init',
        message: `Claude session started (${msg.model || 'unknown model'})`,
        model: msg.model || null,
        sessionId: msg.session_id || null,
        tools: Array.isArray(msg.tools) ? msg.tools : [],
        mcpServers: Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [],
      });
    }
    return events;
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const c of msg.message.content) {
      if (c?.type === 'text' && c.text) events.push({ type: 'text', text: c.text });
      else if (c?.type === 'tool_use') events.push({ type: 'tool', id: c.id || null, name: c.name, input: c.input ?? {} });
    }
    return events;
  }
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const c of msg.message.content) {
      if (c?.type === 'tool_result') {
        events.push({ type: 'tool_result', toolUseId: c.tool_use_id || null, isError: Boolean(c.is_error), text: toolResultText(c.content) });
      }
    }
    return events;
  }
  if (msg.type === 'result') {
    events.push({
      type: 'result',
      ok: !msg.is_error && (msg.subtype === undefined || msg.subtype === 'success'),
      subtype: msg.subtype || null,
      text: typeof msg.result === 'string' ? msg.result : '',
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
      numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
      sessionId: msg.session_id || null,
      isError: Boolean(msg.is_error),
    });
  }
  return events;
}

/**
 * Run one non-interactive Claude CLI session.
 * Never throws for CLI failures: the result carries ok:false and an error message.
 */
export async function runClaude({
  config,
  prompt,
  systemPrompt,
  model,
  mcpConfig,
  allowedTools = [],
  builtinTools = '',
  jsonSchema,
  maxBudgetUsd,
  timeoutMs,
  cwd,
  onEvent,
  signal,
  env,
} = {}) {
  const started = Date.now();
  const agentCfg = config?.agent || {};
  const bin = resolveBin(agentCfg.claudeBin || 'claude');
  const effectiveModel = model || agentCfg.model || undefined;
  const effectiveTimeout = timeoutMs ?? agentCfg.timeoutMs ?? 240_000;
  const budget = maxBudgetUsd ?? agentCfg.maxBudgetUsd;
  const workDir = cwd || path.join(config?.dataDir || os.tmpdir(), 'agent-work');
  fs.mkdirSync(workDir, { recursive: true });

  let tmpDir = null;
  let mcpConfigFile;
  if (mcpConfig) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-claude-'));
    mcpConfigFile = path.join(tmpDir, 'mcp-config.json');
    fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  }
  const args = buildClaudeArgs({ model: effectiveModel, builtinTools, mcpConfigFile, allowedTools, systemPrompt, maxBudgetUsd: budget, jsonSchema });

  const emit = (e) => {
    if (!onEvent) return;
    try {
      onEvent(e);
    } catch {
      // A misbehaving listener must not break the run.
    }
  };

  const result = await new Promise((resolve) => {
    const texts = [];
    let resultEvent = null;
    let resultMsg = null;
    let stderr = '';
    let buffer = '';
    let badLines = 0;
    let killedFor = null;
    let settled = false;
    let child;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      const text = (resultEvent?.text || texts.join('\n\n')).trim();
      const ok = !extra.error && Boolean(resultEvent?.ok);
      let error = extra.error || null;
      if (!error && !resultEvent) {
        error = `Claude CLI exited${extra.code != null ? ` with code ${extra.code}` : ''} without a result` +
          (stderr.trim() ? `: ${stderr.trim().slice(-400)}` : badLines ? ` (${badLines} unparseable output lines)` : '');
      } else if (!error && !resultEvent.ok) {
        error = resultEvent.text || `Claude reported an error (${resultEvent.subtype || 'is_error'})`;
      }
      resolve({
        ok,
        text,
        costUsd: resultEvent?.costUsd ?? null,
        durationMs: resultEvent?.durationMs ?? Date.now() - started,
        sessionId: resultEvent?.sessionId ?? null,
        numTurns: resultEvent?.numTurns ?? null,
        isError: resultEvent ? resultEvent.isError : true,
        error: ok ? null : error,
        structuredOutput: resultMsg?.structured_output ?? null,
        stderr: stderr.slice(-2000),
        raw: resultMsg,
      });
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        badLines++;
        return;
      }
      if (msg?.type === 'result') resultMsg = msg;
      for (const ev of normalizeMessage(msg)) {
        if (ev.type === 'text') texts.push(ev.text);
        if (ev.type === 'result') resultEvent = ev;
        emit(ev);
      }
    };

    const kill = (reason) => {
      if (!child || child.exitCode !== null || killedFor) return;
      killedFor = reason;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000).unref();
    };
    const onAbort = () => kill('aborted');
    const timer = setTimeout(() => kill('timeout'), effectiveTimeout);

    try {
      child = spawn(bin, args, { cwd: workDir, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ error: spawnErrorMessage(e, bin) });
    }
    if (signal) {
      if (signal.aborted) kill('aborted');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    emit({ type: 'status', stage: 'spawn', message: `Starting Claude CLI (${effectiveModel || 'default model'})` });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });
    child.stdin.on('error', () => {}); // EPIPE if the CLI exits before reading stdin
    child.on('error', (e) => finish({ error: spawnErrorMessage(e, bin) }));
    child.on('close', (code) => {
      if (buffer) handleLine(buffer);
      buffer = '';
      if (killedFor === 'timeout') return finish({ error: `Claude CLI timed out after ${effectiveTimeout} ms` });
      if (killedFor === 'aborted') return finish({ error: 'Claude run aborted' });
      finish({ code });
    });
    child.stdin.end(String(prompt ?? ''));
  });

  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}
