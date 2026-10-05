# Cairn

Cairn is a personal desktop assistant for macOS, in the same family as ChatGPT Agent and Grok. A small
animated avatar floats above your other windows, and clicking it opens a chat panel. You can ask Cairn
to:

- remind you of things and run recurring tasks
- search and research the web
- shop for you (it compares products and builds a list, but **never pays**)
- do computer tasks on your Mac (files, terminal, apps, browser), asking for your approval first

Requests keep running in the background after you close the panel. The "brain" is the Claude CLI
(`claude -p`, using your existing Claude login). Cairn also includes its own transparent search and crawl
engine that respects robots.txt, which the assistant uses as its search skill (see `SPEC.md`).

macOS, Node 20+, zero npm dependencies (no `npm install`). Building the desktop app needs the Xcode
command-line tools (`swift`).

## Quick start

```sh
node bin/cairn.js serve          # API, dashboard, assistant and scheduler on http://127.0.0.1:8787
node bin/cairn.js desktop --install   # build, install /Applications/Cairn.app, keep it in the Dock, start the bubble
node bin/cairn.js desktop --install --no-dock   # the same, but leave the Dock alone
node bin/cairn.js desktop        # later: start it (or click its Dock icon, Spotlight › Cairn, Apps / Launchpad)
open http://127.0.0.1:8787/assistant   # the full-page assistant in a browser
open http://127.0.0.1:8787/docs/       # documentation with diagrams
```

The engine on its own, with no Claude login needed: `node bin/cairn.js demo --no-claude` crawls a
bundled demo site, then searches it and answers a question from it.

## Key commands

| Command | What it does |
| --- | --- |
| `chat "find me a quiet 4-person tent under $200"` | Ask the assistant. It streams the reply, its tool steps and any approval requests (`--conversation ID` continues a chat) |
| `remind "in 10 minutes stretch"` / `remind "every weekday at 8:30 standup"` | Schedule a reminder or a recurring task |
| `tasks` · `tasks cancel <id>` · `tasks run <id>` | List, cancel or run upcoming tasks now |
| `approvals` · `approvals approve <id> [--always]` · `approvals deny <id>` | Review tool calls that are waiting for your approval |
| `shopping` | Show the shopping list |
| `assistant` | Open the full-page assistant in your browser |
| `desktop [--rebuild \| --restart \| --quit]` | Build or launch the bubble app, or quit it |
| `desktop --install [--no-launch] [--no-dock]` | Install `/Applications/Cairn.app`, keep it in the Dock (unless `--no-dock`) and start it |
| `serve [--port N]` · `doctor` · `help` | Run the server, check your setup, list every command |
| `crawl` · `search` · `ask [--deep]` · `fetch` · `robots` · `audit` | Search-engine commands (see `docs/cli.html`) |

Run every command as `node bin/cairn.js <command>`. The assistant commands talk to the running server, and
`--port` overrides the port.

## Safety model

- **Approval before risky actions.** Cairn lets Claude do these on its own: read files, search, fetch
  web pages, use read-only browser tools, and run Cairn's own tools (reminders, notifications, the
  shopping list). Everything else asks you first with an Approve / Deny card in the bubble or through
  `cairn approvals`, including Bash, file writes and edits, browser clicks and typing, and reading the
  clipboard. If nobody answers, the request is denied: after 5 minutes normally, or after 60 s for an
  unattended scheduled task. "Always allow" applies to one conversation only.
- **Isolated from your personal Claude settings.** Runs use `--setting-sources ""`, so the allow
  rules in your `~/.claude/settings.json` cannot skip Cairn's approvals. Each run also has a spending
  cap (`--max-budget-usd`, $2 by default).
- **Contained working directory.** Runs start in `~/CairnWorkspace`. Your home folder is reachable
  for reading, but changes there still need your approval.
- **Never pays.** Shopping stops at research, comparison and the cart. Checkout is always yours.
- **Local only.** The server binds to `127.0.0.1`. It checks the Host and Origin headers, accepts only
  JSON bodies and limits their size. As a crawler it identifies itself honestly (`CairnSearch`,
  `CairnCorpus`, `Cairn-User`), follows robots.txt and signs its requests (Web Bot Auth).

## Where data lives

Data is stored in `./data`, or in `$CAIRN_HOME` / `--data-dir` if you set one:

- `conversations/`, `runs.json`, `tasks.json`, `shopping.json` and `assistant-settings.json` (assistant)
- `index.json`, `audit.ndjson` and `keys/` (search engine and signing key)
- `server.log` (the server started by the desktop app)

The bubble's position and avatar choice are stored in macOS user defaults. The app is built into
`desktop/build/Cairn.app` and installed as `/Applications/Cairn.app` (or `~/Applications` if
`/Applications` is not writable), and the install pins it to the Dock once (`--no-dock` skips that; to
unpin, right-click the Dock icon › Options › uncheck Keep in Dock). While it runs it has a Dock icon:
clicking it opens the chat, its menu offers Open Chat, New Chat, Dashboard, Docs, the task/approval count
and Start at Login, and its badge counts pending approvals. The menu bar's Edit menu makes ⌘C/⌘V/⌘A/⌘Z
work in the chat. Right-click the bubble › Show in Dock turns the Dock icon and menu bar off (bubble only).
After changing the Swift app, an avatar or the icon, run `node bin/cairn.js desktop --install` again to
update the installed copy.
Uninstall: quit Cairn, remove it from the Dock, then move `/Applications/Cairn.app` to the Trash. Details:
`docs/desktop.html#install`.

## Tests

```sh
npm test            # 400 tests: 398 pass, 2 skipped (live-only), about 6 s
npm run test:live   # optional: the real Claude CLI over the demo site (costs a few cents)
bash desktop/build.sh   # build the desktop app and run its built-in self-test (37 checks)
```

The latest results, including the live assistant scenarios, are in `docs/testing.html#results`.
`SPEC.md` (engine) and `SPEC-ASSISTANT.md` (assistant) are the build contracts.
