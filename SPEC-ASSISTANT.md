# Cairn Assistant — Build Contract (SPEC-ASSISTANT)

Cairn grows from a web retrieval engine (SPEC.md — being finished in parallel) into a **personal desktop
assistant** like ChatGPT Agent / Operator / ChatGPT Tasks and Grok Tasks: it **schedules reminders & recurring
tasks, searches & researches, shops (research → compare → cart, never pays), and performs computer tasks**
(files, terminal, Mac apps, browser automation) — with **human approval for risky actions**. It lives in a
**floating desktop bubble** (always on top, draggable anywhere, default top-right) that expands into a chat panel.
The brain is the **Claude CLI** (`claude -p`, user's Enterprise login).

Hard rules: same as SPEC.md (Node 20, zero npm deps, ES modules, node:test, bind 127.0.0.1, no shell:true,
honest identity). Only edit files you own. Read SPEC.md for the existing engine (runtime, audit, config, API
guards: POST/DELETE need `Content-Type: application/json`, Origin must match).

## Architecture
```
 Desktop bubble (Swift NSPanel + WKWebView) ──loads──▶ http://127.0.0.1:8787/web/bubble.html
                                                           │  fetch/EventSource /api/assistant/*
 Cairn server (node bin/cairn.js serve) ── src/assistant/routes.js (createAssistant)
    ├─ AssistantAgent ── spawns `claude -p --output-format stream-json --verbose --resume <session>`
    │                     --mcp-config {assistant: mcp-tools.js, cairn: src/agent/mcp-server.js, playwright?}
    │                     --permission-prompt-tool mcp__assistant__approval_prompt
    ├─ ApprovalQueue  ◀── approval_prompt tool (long-poll) ──▶ bubble shows Approve/Deny card
    ├─ TaskScheduler  ── reminders & recurring agent tasks → macOS notification + bubble alert
    ├─ Conversations  ── <dataDir>/conversations/<id>.json (+ claude session id for --resume)
    └─ Shopping list  ── <dataDir>/shopping.json
```

## Module: assistant-core (owner: assistant-core)
Files: `src/assistant/agent.js`, `src/assistant/conversations.js`, `src/assistant/approvals.js`,
`test/assistant-core.test.js`, `test/fixtures/fake-claude-assistant.js`.

`class ConversationStore` — `constructor({dir})`; `create({title}) → conv`; `get(id)`; `list() → [{id,title,updatedAt,messageCount}]` newest first; `append(id, msg)`; `setSession(id, sessionId)`; `remove(id)`. conv = `{id, title, createdAt, updatedAt, sessionId|null, allowAlways:[toolName], messages:[{id, role:'user'|'assistant'|'system', text, ts, events?:[...], costUsd?}]}`. JSON file per conversation, atomic writes.

`class ApprovalQueue extends EventEmitter` — `constructor({timeoutMs=300000})`;
`request({toolName, input, conversationId, runId}) → {id, promise}` (promise resolves `{allow:boolean, updatedInput?, message?, always?:boolean}`; timeout → `{allow:false, message:'No response from user (timed out)'}`); `resolve(id, decision) → boolean`; `get(id)`; `pending() → [{id, toolName, input, conversationId, runId, createdAt, summary}]`; events `'request'`, `'resolved'`. `summary` = one-line human description (e.g. `Run shell command: ls -la ~/Downloads`, `Click "Add to cart" in browser`).

`class AssistantAgent` — `constructor({runtime, conversations, approvals, getApiUrl: () => string, settings})`
- `startRun({conversationId?, message, unattended=false}) → {runId, conversationId}` — creates conversation if needed (title = first 60 chars), appends user message, runs Claude async, buffers events; `subscribe(runId, fn) → unsubscribe` replays buffered events then streams; `getRun(runId) → {runId, conversationId, state:'running'|'done'|'error', events}`; `cancel(runId)`.
- Spawns `config.agent.claudeBin` (args array, prompt via stdin, cwd `settings.workDir` default `os.homedir()`):
  `-p --output-format stream-json --verbose --model <settings.model||config.agent.model> [--resume <conv.sessionId>] --strict-mcp-config --mcp-config <tmp json> --permission-prompt-tool mcp__assistant__approval_prompt --allowedTools <auto list> --append-system-prompt <assistant prompt> --max-budget-usd <settings.maxBudgetUsd>`.
  MCP config: `assistant` → `node src/assistant/mcp-tools.js` env `{CAIRN_API, CAIRN_CONVERSATION_ID, CAIRN_RUN_ID, CAIRN_UNATTENDED}`; `cairn` → `node src/agent/mcp-server.js` env `{CAIRN_API, CAIRN_SOURCES_FILE}`; `playwright` → `npx -y @playwright/mcp@latest` only if `settings.allowBrowser`.
  Auto-approved (`--allowedTools`): all `mcp__assistant__*` except `clipboard_read`; `mcp__cairn__search_index, mcp__cairn__fetch_page, mcp__cairn__check_robots, mcp__cairn__index_stats`; built-ins `Read, Glob, Grep, WebSearch, WebFetch`; playwright read-only (`mcp__playwright__browser_navigate, browser_navigate_back, browser_snapshot, browser_take_screenshot, browser_tabs, browser_wait_for`) plus all playwright tools if `settings.autoApproveBrowser`; plus conversation `allowAlways`. Everything else (Bash, Write, Edit, browser_click/type/fill_form…, clipboard_read) goes through the permission prompt tool → ApprovalQueue.
  System prompt (append): Cairn personal assistant on the user's Mac; current local date/time + timezone; capabilities & which tool to use (schedule_task for reminders/recurring tasks — compute exact local ISO times; apple_reminder / calendar_event when the user asks for Reminders/Calendar apps; web search/research; browser for shopping & web tasks; terminal/files with approval); **shopping rule: research, compare (table: product, store, price, rating, link), may add to cart, NEVER enter payment details or place orders — hand checkout to the user with the link**; ask before sending any message/email; be concise; if unattended (scheduled run) do not ask questions.
  Parse stream-json (same as SPEC.md runClaude): events emitted to subscribers: `{type:'status', message}`, `{type:'text', text}`, `{type:'tool', name, input, id}`, `{type:'tool_result', id, name, isError, summary}`, `{type:'approval', approval}` / `{type:'approval_resolved', id, allow}` (forwarded from ApprovalQueue for this runId), `{type:'result', text, costUsd, durationMs, sessionId}`, `{type:'error', message}`, `{type:'done'}`. On result: save assistant message (text, costUsd, events summary) and `setSession`. If `--resume` fails (session missing), retry once without it. Record `audit.record({kind:'agent', mode:'assistant', ...})`.
- `async runOnce(prompt, {unattended:true}) → {text, costUsd, ok}` for scheduled agent tasks (new conversation titled "Scheduled: …").

## Module: assistant-tools (owner: assistant-tools)
Files: `src/assistant/mcp-tools.js`, `src/assistant/macos.js`, `test/assistant-tools.test.js`.

`macos.js` (execFile `osascript`/`open`/`pbcopy`/`pbpaste`; never a shell; escape AppleScript strings: backslash and double quote; build dates from components — never parse locale date strings). If `process.env.CAIRN_MAC_DRYRUN === '1'` → don't execute, return `{ok:true, dryRun:true, script}`.
`notify({title, message, sound=true})`, `addReminder({title, due?: ISO, list?, notes?})` (Reminders.app), `addCalendarEvent({title, start: ISO, end?: ISO (default +1h), calendar?, location?, notes?})` (Calendar.app; default calendar = first writable), `openUrl(url)` (http/https only), `openApp(name)` (`open -a`), `clipboardRead()`, `clipboardWrite(text)`, `say(text)`. All return `{ok, error?, dryRun?, script?}`.

`mcp-tools.js` — stdio MCP server named `assistant` (same JSON-RPC framing as SPEC.md mcp-server; stdout = protocol only). Proxies to `process.env.CAIRN_API`. Tools (JSON-schema inputSchema each):
- `schedule_task {title, when (ISO 8601 local or with offset), kind:'reminder'|'agent'='reminder', prompt?, notes?, recurrence?:{every:'minute'|'hour'|'day'|'week'|'weekday', interval?:number, at?:'HH:MM', days?:['mon',…]}}` → POST /api/assistant/tasks
- `list_tasks {}` → GET /api/assistant/tasks; `cancel_task {id}` → DELETE /api/assistant/tasks/:id
- `notify {title, message}` → POST /api/assistant/notify
- `apple_reminder {title, due?, list?, notes?}` → POST /api/assistant/mac/reminder; `calendar_event {title, start, end?, calendar?, location?, notes?}` → POST /api/assistant/mac/calendar
- `open_url {url}` / `open_app {name}` → POST /api/assistant/open `{url}|{app}`
- `web_research {query, limit?}` → POST /api/search (Cairn index) — tool description tells Claude to also use WebSearch for live results
- `shopping_list_add {item, url?, price?, store?, notes?}`, `shopping_list {}`, `shopping_list_remove {id}` → /api/assistant/shopping
- `clipboard_read {}` / `clipboard_write {text}` → POST /api/assistant/clipboard `{op:'read'|'write', text?}`
- `approval_prompt {tool_name, input, tool_use_id?}` — **permission prompt tool**: POST /api/assistant/approvals `{toolName, input, conversationId: env, runId: env}` → `{id}`; then loop GET /api/assistant/approvals/:id/wait (each ≤ 60 s long-poll) until decided (overall ≤ 5 min; if `CAIRN_UNATTENDED=1` and not decided in 60 s → deny). Return tool result text = `JSON.stringify({behavior:'allow', updatedInput: input})` or `JSON.stringify({behavior:'deny', message})`.
Tests: spawn mcp-tools.js against an in-test fake API (node:http port 0): initialize, tools/list (all tools with schemas), schedule_task proxy body, approval_prompt allow + deny paths (fake API decides), macos dry-run script contents for reminder/calendar/notify (escaping of quotes), openUrl rejects non-http. One REAL `notify` call is allowed as a smoke test (harmless notification).

## Module: scheduler (owner: scheduler)
Files: `src/assistant/scheduler.js`, `src/assistant/when.js`, `test/scheduler.test.js`.

`class TaskScheduler extends EventEmitter` — `constructor({file, now?: () => Date, tickMs=5000})`; `start()`, `stop()`;
`add({title, kind='reminder', when, recurrence=null, prompt, notes}) → task`; `list({includeDone=false})` sorted by nextRunAt; `get(id)`; `cancel(id)`; `update(id, patch)`; `runNow(id)`; `markRun(id, {ok, summary})`.
task = `{id, title, kind, prompt, notes, recurrence, status:'active'|'done'|'cancelled', createdAt, nextRunAt (ISO), lastRunAt, runs:[{at, ok, summary}] (last 20)}`. On tick: every active task with `nextRunAt <= now` → `emit('due', task)` exactly once, then advance `nextRunAt` via recurrence (skipping past occurrences — no burst after sleep) or set `status:'done'`. Overdue one-shots found at start fire once. Persist atomically to `file` on every change.
`nextOccurrence(recurrence, from: Date) → Date` — every minute/hour/day/week/weekday with interval, `at:'HH:MM'` local time, `days` filter.
`when.js`: `parseWhen(text, now=new Date()) → {when: ISO, recurrence|null, title: remaining text} | null` for common English: "in 10 minutes/2 hours/3 days", "at 5pm", "at 17:30", "tomorrow at 9am", "tonight", "tomorrow morning", "next monday at 10", "on friday", "every day at 8am", "every weekday at 9", "every monday", "every 30 minutes", "every hour"; also accepts ISO strings. Strips phrases like "remind me to". Local timezone.
Tests with an injected clock: one-shot fires once; recurring daily advances; weekday skips weekend; interval minutes; overdue at start; cancel; persistence reload; parseWhen table ≥ 20 cases.

## Module: assistant-api (owner: assistant-api)
Files: `src/assistant/routes.js`, `src/assistant/shopping.js`, `test/assistant-routes.test.js`.

`createAssistant({runtime}) → {handle(req, res, url) → Promise<boolean>, agent, approvals, scheduler, conversations, shopping, settings, start(), stop()}` — `handle` returns false for paths not under `/api/assistant/` so `src/server/api.js` can delegate (wired later by the integrator). Uses helpers it defines itself (readJson ≤1 MB, sendJson, SSE with 15 s heartbeat). `getApiUrl` = `runtime.config.publicBaseUrl`.
Settings: `<dataDir>/assistant-settings.json` `{model, maxBudgetUsd:2, workDir: os.homedir(), allowBrowser:true, autoApproveBrowser:false, notifyWithMac:true}`.
On scheduler `'due'`: reminder → `macos.notify` (if notifyWithMac) + broadcast `{type:'reminder', task}`; agent task → `agent.runOnce(task.prompt)` → `scheduler.markRun` → notify with a short summary + broadcast `{type:'task_result', task, text}`.
Routes:
- `POST /api/assistant/chat {message, conversationId?}` → 202 `{runId, conversationId}`; `GET /api/assistant/runs/:runId/events` → SSE (replay + live; events named by `type`, data JSON); `POST /api/assistant/runs/:runId/cancel`.
- `GET /api/assistant/conversations` → `{conversations}`; `GET /api/assistant/conversations/:id`; `DELETE /api/assistant/conversations/:id`.
- `GET /api/assistant/approvals` → `{pending}`; `POST /api/assistant/approvals {toolName, input, conversationId, runId}` → `{id}` (called by the MCP permission tool); `GET /api/assistant/approvals/:id/wait?timeout=60` → `{decided:boolean, decision?}`; `POST /api/assistant/approvals/:id {allow, message?, always?}` → `{ok}` (always → add toolName to conversation allowAlways).
- `GET /api/assistant/tasks` → `{tasks}`; `POST /api/assistant/tasks {title, when | text, kind, prompt, notes, recurrence}` (if `text` given, use parseWhen) → 201 `{task}`; `DELETE /api/assistant/tasks/:id`; `POST /api/assistant/tasks/:id/run`; `POST /api/assistant/tasks/parse {text}` → parseWhen result.
- `POST /api/assistant/notify {title, message}`; `POST /api/assistant/mac/reminder`; `POST /api/assistant/mac/calendar`; `POST /api/assistant/open {url}|{app}`; `POST /api/assistant/clipboard {op, text?}`.
- `GET /api/assistant/shopping` → `{items}`; `POST /api/assistant/shopping {item, url, price, store, notes}` → `{item}`; `DELETE /api/assistant/shopping/:id`.
- `GET /api/assistant/settings`; `POST /api/assistant/settings` partial.
- `GET /api/assistant/events` → global SSE: `reminder`, `task_result`, `approval` (new pending, any run), `approval_resolved`, `run_started`, `run_done`.
- `GET /api/assistant/health` → `{ok, claude: available?, scheduler:{active}, pendingApprovals}`.
Tests: a minimal node:http server in the test that calls `handle` (fake runtime from `createRuntime({dataDir: tmp})` is fine if available, else a stub `{config, audit}`); CAIRN_MAC_DRYRUN=1; fake claude bin via `config.agent.claudeBin = test/fixtures/fake-claude-assistant.js` (owned by assistant-core — wait for it) → chat run emits text + done; approvals create/wait/resolve; tasks CRUD + parse; due reminder broadcast on /events; shopping CRUD; settings roundtrip.

## Module: bubble-ui (owner: bubble-ui)
Files: `web/bubble.html`, `web/bubble.js`, `web/bubble.css`.
Compact assistant UI designed for a ~400×620 floating panel (also works full-page in a browser). Vanilla JS module, no CDN. Header (cairn logo, "Cairn", health dot, buttons: new chat, open dashboard `/`, collapse → `window.webkit?.messageHandlers?.cairn?.postMessage({type:'collapse'})`). Tabs: **Chat** (messages, streaming via `EventSource('/api/assistant/runs/<id>/events')`, markdown-lite rendering with escaping, tool-step chips ("🔎 Searching…", "🌐 Browser: navigate", "⏰ Scheduled …"), inline **Approval cards** (tool, summary, input preview, Approve / Deny / Always allow) posting to `/api/assistant/approvals/:id`, quick-action chips: "Remind me…", "Search the web for…", "Shop for…", "Organize my Downloads…", composer with Enter to send / Shift+Enter newline, stop button), **Tasks** (upcoming reminders & recurring tasks; quick add with natural language → `/api/assistant/tasks {text}`; cancel; run now), **Shopping** (list with links & prices, remove), **History** (conversations list → reopen). Global `EventSource('/api/assistant/events')`: on `reminder` show a prominent alert banner + `postMessage({type:'attention', title, message})` to the native shell (so the bubble pulses/expands); on `approval` show badge. Persist current conversationId in localStorage. Light/dark. All POSTs `Content-Type: application/json`. Never innerHTML unescaped data.

## Module: desktop (owner: desktop)
Files: `desktop/CairnBubble.swift`, `desktop/build.sh`, `desktop/Info.plist`, `desktop/run.sh`.
Native macOS app (AppKit + WebKit, single Swift file, compiled with `swiftc -O -swift-version 5 -framework Cocoa -framework WebKit`). `build.sh` bakes absolute paths (project root, `$(command -v node)`, and a PATH containing node's dir, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`) into a generated Swift constants file or Info.plist keys, builds `desktop/build/Cairn.app` (Contents/MacOS/Cairn, Info.plist with `LSUIElement=true`, `NSAppTransportSecurity > NSAllowsLocalNetworking=true`, bundle id `com.cairn.bubble`), ad-hoc signs (`codesign --force --deep -s -`). `run.sh` builds if needed and `open`s it.
Behaviour: on launch GET `http://127.0.0.1:8787/api/health`; if unreachable, start `node <root>/bin/cairn.js serve` as a child `Process` with the baked PATH (log to `<root>/data/server.log`), poll until healthy (≤ 20 s). **Bubble**: borderless non-activating `NSPanel`, 64×64 circle (gradient + stacked-stones glyph drawn with NSBezierPath), `level = .floating`, `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]`, transparent background, shadow, default position top-right of the main screen's visibleFrame (16 px inset), **draggable anywhere** (mouseDragged moves the window; a click without drag toggles the chat panel), position saved in UserDefaults and restored (clamped to visible screens). **Chat panel**: 400×620 floating panel with rounded corners containing a `WKWebView` loading `http://127.0.0.1:8787/web/bubble.html`, positioned next to the bubble (flip to stay on-screen), movable by its header region, closes on Esc or bubble click; keeps its web state when hidden. `WKScriptMessageHandler` named `cairn`: `collapse` → hide panel; `attention` → bubble pulse animation + red badge (and auto-open panel if setting). Right-click bubble menu: Open Chat, Open Dashboard (browser → `/`), Open Docs (`/docs/`), Reset Position, Quit Cairn (terminates the server child if this app started it). Keyboard shortcut ⌥Space (local monitor while app active is fine; global hotkey optional) toggles the panel.
Verify: `bash desktop/build.sh` succeeds with no errors; launch with `open desktop/build/Cairn.app`, confirm the process runs (`pgrep -f Cairn.app`), then quit it (`osascript -e 'quit app "Cairn"'` or kill). Do not leave it running.

## Module: assistant-docs (owner: assistant-docs)
Files: `docs/assistant.html`, `docs/desktop.html`. Same template/CSS/Mermaid rules as SPEC.md docs.
`assistant.html`: researched feature catalogue of ChatGPT Agent (Operator + deep research merged, virtual computer, visual browser, terminal, connectors, takeover mode, confirmations before consequential actions, watch mode), ChatGPT Tasks (scheduled reminders/recurring prompts), ChatGPT shopping research / Instant Checkout, Grok Tasks / DeepSearch, Claude for Chrome / computer use → comparison table vs Cairn Assistant (status + file); architecture diagram; ≥ 8 diagrams: chat turn sequence (bubble → API → AssistantAgent → claude -p → MCP tools → API), approval (permission-prompt-tool) sequence, auto-approve vs prompt decision flowchart, reminder lifecycle state machine, recurring agent-task flow, shopping flow with checkout hand-off, computer-task flow (files/terminal with approval), conversation memory (--resume) flow, tool catalogue mindmap; safety model; example prompts.
`desktop.html`: the floating bubble app — what it looks like (ASCII/SVG mock), behaviours (always on top, all Spaces, drag anywhere, click to expand, right-click menu, ⌥Space), lifecycle diagram (launch → health check → spawn server → bubble → panel), build & run (`bash desktop/run.sh`), where state lives, troubleshooting (Gatekeeper for locally built ad-hoc signed apps, EDR/SentinelOne: ask IT to allowlist the app path/hash — never obfuscate; notifications permission for osascript; Automation permission prompts for Reminders/Calendar), uninstall.

## ALWAYS-ON + BACKGROUND TASKS (applies to all assistant modules — overrides anything above)
Like ChatGPT Agent / Grok: the assistant is **always running**, and every request is a **background run** that keeps going when the chat panel is closed; the user can hand off several tasks and keep working.
- assistant-core: runs are independent background jobs; up to `settings.maxConcurrentRuns` (default 3) run at once, extras queue (`state:'queued'`). `listRuns({limit=30}) → [{runId, conversationId, title, state:'queued'|'running'|'waiting_approval'|'done'|'error'|'cancelled', startedAt, finishedAt, lastEvent (one-line), costUsd}]` newest first; state becomes `waiting_approval` while an approval for that run is pending. Runs survive the HTTP client disconnecting (never tie a run's lifetime to an SSE connection). Keep the last 50 runs in memory and persist a compact runs log to `<dataDir>/runs.json` (state of in-flight runs becomes `error: interrupted` after a server restart).
- assistant-api: add `GET /api/assistant/runs` → `{runs}`; broadcast `run_started`, `run_update` (state changes), `run_done` on `/api/assistant/events`; when a run finishes and `settings.notifyOnComplete` (default true) → `macos.notify({title:'Cairn finished: <title>', message:<first 120 chars of result>})`; when an approval is requested → `macos.notify({title:'Cairn needs your approval', message: summary})`. `/api/assistant/health` → add `runningRuns`, `queuedRuns`, `pendingApprovals`, `nextTaskAt`.
- bubble-ui: add an **Activity** tab (first-class, next to Chat): live list of background runs with state chips, elapsed time, last step, cost, open-conversation, cancel. Sending a message never blocks the composer — the user can start another task immediately ("Run in background" is the default behaviour; the chat view just follows the selected run). Show a toast "Working on it in the background — I'll notify you when done" for each started run.
- desktop: the native shell polls `GET /api/assistant/health` every 3 s → animated progress ring around the bubble while `runningRuns > 0`, red badge with `pendingApprovals` count, small amber dot when the server is unreachable. **Watchdog**: if this app started the server and health fails 3 consecutive polls, restart the server child. Right-click menu adds **Start at Login** (toggle; implement with `osascript` → System Events login items for the app path — opt-in only, never automatic) and shows "N tasks running".
- assistant-docs: document the always-on model and background-run lifecycle (state machine: queued → running ⇄ waiting_approval → done/error/cancelled) and the watchdog/login-item behaviour.
