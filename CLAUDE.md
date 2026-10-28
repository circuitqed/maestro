# Maestro - Agent Orchestrator

Web-based dashboard for managing multiple projects and their Claude agents.

**Dashboard URL:** http://localhost:7007

## Tech Stack
- **Frontend**: React 18 + Vite + Tailwind CSS
- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Real-time**: WebSockets for terminal I/O
- **Terminal**: xterm.js v6 + node-pty + tmux

## Project Structure
```
/home/projects/maestro/
├── client/                    # React frontend (Vite)
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   ├── Layout.jsx           # Main app layout
│   │   │   ├── Header.jsx           # Top navigation bar
│   │   │   ├── Dashboard.jsx        # Project/agent cards grid
│   │   │   ├── ProjectCard.jsx      # Individual project card
│   │   │   ├── AgentCard.jsx        # Individual agent card
│   │   │   ├── TerminalPanel.jsx    # Desktop: resizable side panel
│   │   │   ├── TerminalModal.jsx    # Mobile: modal overlay
│   │   │   ├── Terminal.jsx         # xterm.js wrapper
│   │   │   └── LoginForm.jsx        # Authentication
│   │   ├── hooks/
│   │   │   ├── useWebSocket.js      # WebSocket connection
│   │   │   ├── useTerminal.js       # Terminal state/logic
│   │   │   └── useMediaQuery.js     # Responsive breakpoints
│   │   ├── context/
│   │   │   └── AppContext.jsx       # Global state
│   │   └── index.css                # Tailwind imports
│   ├── index.html
│   ├── tailwind.config.js
│   ├── vite.config.js
│   └── package.json
├── server/                    # Express backend
│   ├── index.js               # Entry point
│   ├── routes/
│   │   ├── auth.js
│   │   ├── projects.js
│   │   └── agents.js
│   ├── services/
│   │   ├── db.js              # SQLite database layer
│   │   ├── terminal.js        # PTY management (tmux attachment)
│   │   └── sessionStore.js    # SQLite session store
│   ├── middleware/
│   │   └── auth.js
│   └── package.json
├── data/
│   └── maestro.db             # SQLite database (persisted)
├── docker-compose.yml         # Production Docker config
├── docker-compose.dev.yml     # Development Docker config
├── Dockerfile                 # Production multi-stage build
└── Dockerfile.dev             # Development with hot reload
```

## Running with Docker

### Production
```bash
# Build and start
docker compose up -d --build

# View logs
docker logs -f maestro

# Restart (after code changes)
docker compose down && docker compose up -d --build

# Stop
docker compose down
```

### Development
```bash
# Start with hot reload
docker compose -f docker-compose.dev.yml up -d --build

# View logs
docker logs -f maestro-dev
```

## Local Development (without Docker)

```bash
# Terminal 1: Backend
cd server && npm install && npm run dev

# Terminal 2: Frontend
cd client && npm install && npm run dev

# Vite proxies /api/* to http://localhost:5000
```

Open http://localhost:3000 for development (Vite dev server with HMR)

## Port
- **7007** (host) → 5000 (container) - Production
- **3000** - Vite dev server (development only)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Authenticate |
| POST | /api/auth/logout | End session |
| GET | /api/auth/session | Check auth status |
| GET | /api/projects | List projects |
| POST | /api/projects | Create project |
| PATCH | /api/projects/:id | Update project |
| DELETE | /api/projects/:id | Delete project |
| GET | /api/projects/colors | Get available colors |
| GET | /api/agents | List all agents |
| GET | /api/projects/:id/agents | List project agents |
| GET | /api/agents/sessions | List available tmux sessions (`?hostId=N` for a remote host) |
| POST | /api/agents | Create agent (accepts `hostId`) |
| PATCH | /api/agents/:id/status | Update status |
| POST | /api/agents/:id/input | Inject text into the agent's tmux session (chat send box) |
| POST | /api/agents/:id/answer | Answer an active select prompt (presses option number 1-9) |
| GET | /api/agents/:id/pane | Capture the live pane (chat uses it to detect active questions) |
| GET | /api/agents/:id/transcript/meta | Whether a transcript file was located `{available, sessionId}` |
| DELETE | /api/agents/:id | Delete agent |
| GET | /api/hosts | List hosts |
| POST | /api/hosts | Add remote host (admin; accepts `pathPrefix`, `defaultRoot`) |
| PATCH | /api/hosts/:id | Update host `name`/`pathPrefix`/`defaultRoot` (admin) |
| DELETE | /api/hosts/:id | Delete host (admin; not local, not if agents reference it) |
| POST | /api/hosts/:id/test | Test connectivity (runs `tmux -V`, persists status) |
| GET | /api/agents/:id/usage | One agent's plan utilization (what `/usage` shows) |
| GET | /api/usage/plans | Every plan in the fleet, grouped by login identity, with the agents on each |
| GET | /api/usage/pricing | What this build believes tokens cost, and when that was verified |
| POST | /api/hosts/:id/upload | Send a file to a host, into `<default_root>/inbox` |
| GET | /api/agent/usage | **Agent-facing**: the caller's own plan utilization |
| GET | /api/agent/usage/plans | **Agent-facing**: same all-plans view |

## WebSocket Protocol

Connect to: `ws://host/ws/terminal?session=<tmux-session-name>&host=<hostId>`

(`host` is optional; absent — or a host row with a NULL `ssh_target` — attaches locally.)

```javascript
// Client → Server
{ type: 'input', data: 'command\r' }
{ type: 'resize', cols: 80, rows: 24 }

// Server → Client
{ type: 'output', data: '...', encoding: 'base64' }  // Base64 encoded for UTF-8 safety
{ type: 'ready', session: 'session-name' }
{ type: 'error', message: 'Session not found' }
{ type: 'exit', code: 0 }
```

### Transcript stream (chat view, read-only)

Connect to: `ws://host/ws/transcript?agent=<agentId>`

```javascript
// Server → Client (no client → server messages; sending uses POST /api/agents/:id/input)
{ type: 'record', record: { /* one parsed JSONL line, history then live */ } }
{ type: 'error', message: '...' }
{ type: 'end' }   // the tail process exited
```

## Chat View (alternate to the terminal)

Each agent can be opened as **Terminal** (xterm attached to tmux) or **Chat** (a
rich rendering of its Claude Code conversation) — a Terminal|Chat toggle in the
panel/modal header switches live. The tmux TUI stays the single source of truth:

- **Read:** `server/services/transcript.js` tails the session's JSONL transcript
  (`tail -n +1 -F` — history then live, host-aware over SSH), partial-line
  buffered and parsed per record, streamed over `/ws/transcript`.
  `ChatView.jsx` renders text (react-markdown), collapsible thinking, tool-use
  cards, and tool-result cards with inline base64 images.
- **Write:** the send box POSTs to `/api/agents/:id/input`, which calls
  `tmux.js` `sendText()` — `set-buffer` + `paste-buffer` + `Enter` (all values
  `shellQuote`'d; paste, not send-keys, so literal text can't be interpreted as
  tmux keys).
- **Active questions:** when an agent shows an interactive select (AskUserQuestion,
  plan approval, …), the tool_use is NOT in the transcript until answered — it's
  only in the live pane. The chat polls `GET /api/agents/:id/pane`, parses the
  numbered widget, and renders clickable options; a click POSTs to `/answer`,
  which presses that option's number key (`tmux send-keys <n>`) to select+submit.
  Answered questions render from the transcript with the chosen option marked.
- **Locating the transcript:** the filename equals the session UUID. On claude
  start, Maestro pins `--session-id <uuid>` (stored in `agents.claude_session_id`)
  so the file is found by globbing `<uuid>.jsonl`; fallback is the newest `.jsonl`
  in the project's encoded-cwd dir. Start chooses `--session-id` (first/empty) vs
  `--resume` (existing transcript) by whether the file already exists — Claude
  rejects `--session-id` when it exists and `--resume` when it doesn't.

## Terminal UX

- **Desktop (>= 768px):** Full-height resizable side panel using react-resizable-panels
- **Mobile (< 768px):** Full-screen modal overlay with visual viewport tracking (keyboard-aware)
- **Text selection:** "Select" button (both desktop header and mobile toolbar) opens buffer as native selectable text overlay
- **CanvasAddon:** Must be disposed separately (try-catch) before terminal.dispose() to avoid crash

## Database Schema

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT,
  description TEXT,
  color TEXT DEFAULT '#7c3aed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  name TEXT NOT NULL,
  screen_session TEXT,  -- Actually stores tmux session name (legacy column name)
  status TEXT DEFAULT 'stopped',
  config JSON DEFAULT '{}',
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  host_id INTEGER,           -- references hosts(id); NULL => local
  claude_session_id TEXT,    -- pinned Claude session UUID (locates the chat transcript)
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  project_id INTEGER,
  agent_id INTEGER,
  message TEXT
);

CREATE TABLE hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  ssh_target TEXT,          -- NULL => local host (oracle); else user@hostname
  path_prefix TEXT,         -- PATH prepended to remote commands (macOS/homebrew)
  default_root TEXT,        -- new remote agents default their cwd to <default_root>/<agent-slug>
  status TEXT DEFAULT 'unknown',  -- online | offline | unknown
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- agents.host_id INTEGER references hosts(id); NULL => local
```

## Multi-Host Orchestration (SSH)

Agents can run on remote machines over SSH (e.g. a Mac mini on the same Tailscale
network). The seeded local host `oracle` (`ssh_target` NULL) runs commands directly;
remote hosts wrap every tmux command in `ssh <target> 'export PATH=<prefix>:$PATH; <cmd>'`.

- **Why the PATH prefix:** non-interactive SSH gets a bare `PATH` (`/usr/bin:/bin:...`),
  so `tmux`/`claude` (in `/opt/homebrew/bin`, `~/.local/bin`) won't resolve. Default
  prefix: `/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin` (override per host).
- **Transport:** `server/services/hosts.js` — `execOnHost(host, cmd)` (local `exec` /
  remote `execFile('ssh', …)`) and `attachSpawnArgs(host, session)` for the terminal
  PTY (`ssh -t … tmux attach`). SSH uses **ControlMaster multiplexing**
  (`~/.ssh/sockets/`, ControlPersist 600s) so the 2s monitor polling reuses one
  connection instead of reconnecting each tick.
- **Quoting:** session names, project paths, agent names, and the built provider
  command all cross a shell boundary — everything is single-quoted via `shellQuote()`
  (never raw double quotes). Session names are additionally charset-validated
  (`isValidSessionName`, `[A-Za-z0-9._-]+`) at every entry point.
- **Unreachable hosts:** the monitor probes each host once per tick (grouped) and
  concurrently; a host that fails to answer leaves its agents' state untouched (a
  sleeping Mac mini does **not** flip its still-running agents to `stopped`). A
  reentrancy guard prevents overlapping sync runs.
- **Setup:** SSH key auth from the container to the host must work (the container
  mounts `/home/dave`, so `~/.ssh/id_ed25519` is available). Add hosts via the
  **Manage Hosts** UI (admin) or `POST /api/hosts`, then **Test**.

## Current Projects Tracked
- deep-blue-brawl (port 7847)
- moto-game (port 7848)
- razzle (port 7492, multi-agent)
- birdbrain
- mafia
- maestro (this project, port 7007)

## tmux Session Management

Maestro connects to existing tmux sessions. Create and manage sessions on the host:

```bash
# Create a new detached session
tmux new-session -d -s my-agent

# List all sessions
tmux list-sessions

# Attach to a session manually
tmux attach -t my-agent

# Kill a session
tmux kill-session -t my-agent

# Create a session and run a command
tmux new-session -d -s my-agent 'claude'
```

### Why tmux over screen?
- Better UTF-8/Unicode support (important for Claude Code's UI)
- More active development
- Better scripting capabilities
- Cleaner session management

### tmux Cheatsheet (inside a session)
- `Ctrl+b d` - Detach from session
- `Ctrl+b c` - New window
- `Ctrl+b n/p` - Next/previous window
- `Ctrl+b [` - Scroll mode (q to exit)

## Playwright Browser Testing

All Claude Code agents have Playwright MCP tools available via `~/.claude.json`. This enables any agent to interactively test web UIs.

**Config** (in `~/.claude.json` mcpServers):
```json
"playwright": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chromium"]
}
```

**Available tools:** `browser_navigate`, `browser_click`, `browser_snapshot`, `browser_take_screenshot`, `browser_type`, `browser_evaluate`, `browser_fill_form`, etc.

**Testing maestro itself:** Requires session cookie injection since login is password-protected. Use `cookie-signature` to sign a session ID with the secret from `server/index.js`.

## Plan Usage (the `/usage` equivalent)

`/usage` is a slash command, so its numbers only exist on the screen of whoever typed
it: an agent cannot see them, and a human cannot tell which of several plans ran out
without opening each pane. Three surfaces read the same source
(`https://api.anthropic.com/api/oauth/usage` for Claude, `rate_limits` in the newest
rollout for Codex):

- **Agents:** `maestro-usage` (own plan) and `maestro-usage plans` (all of them).
  Installed by `scripts/install-agent-cli.sh`; identity comes from the tmux session,
  never a flag.
- **Dashboard:** *Plan usage* in the header menu (`PlanUsage.jsx`).
- **Per agent:** the existing badge on an agent row.

**Plans are grouped by login identity, not by host** — and that is the point. One
subscription signed in on four hosts is ONE plan with ONE five-hour window; the agents
across all four draw it down together. Keyed by config dir it would read as four plans
each with its own headroom, which is backwards. Accounts with no readable email fall
back to `host:dir` so an unidentified login is never silently merged into another plan.

An **oauth** account has plan windows. An **api** (gateway) account has a budget
instead — the same question in dollars — via `gatewayUsage.js`:

- The Stanford gateway is **LiteLLM**, which reports the key's budget only in RESPONSE
  HEADERS (`x-litellm-key-max-budget`, `x-litellm-key-spend`). `/key/info` would also
  carry `budget_reset_at` but this key is restricted to `llm_api_routes` and is refused.
- **The probe therefore costs money** — those headers need a billed call, and the free
  allowed routes (`/v1/models`, `/v1/messages/count_tokens`) return 200 with no budget
  headers. One probe is ~$0.000025; TTL is 5 min (vs 90s for the free Claude probe), so
  ~$0.22/month no matter how many agents ask. `usage_probe_disabled=1` turns it off.
- The key cannot use cheap models (`claude-haiku-*` → 403 `key_model_access_denied`,
  and a 403 has no headers either). Allowed: `claude-opus-5-5`, `gpt-6-astra`, `gpt-6-sol`.
- **The reset day is not exposed anywhere**, so it is *learned*: spend only rises within
  a cycle, so a reading lower than the last proves a reset happened in between. Until
  one is seen it reports "reset day not yet observed" rather than assuming the 1st —
  a guessed date is indistinguishable from a known one when it matters. History lives in
  the `gateway_budget_state` setting.
- **api accounts group by a fingerprint of the key** (sha256, first 12 chars, computed
  host-side so the token never travels), for the same reason oauth groups by email: one
  key installed on two hosts is ONE cap. Listed per host it showed two $5,000 budgets,
  implying $4,790 of headroom where there was $2,394.

A **bedrock** account still reports "no usage source".

`pricing.js` holds token prices with a verified-on date and a `pricing_overrides`
settings key. Nothing in a transcript carries a cost, so every dollar figure is
tokens x that table; an unpriced model reports `null`, never an estimate. On a
subscription the dollars are API-equivalent value, not a bill.

**This is measurement, not a budget.** No caps, no thresholds, no "you have N left, so
stop" — a number handed to an agent becomes a target it optimises against.

### Sending files to a host

`POST /api/hosts/:id/upload` lands a file in `<default_root>/inbox` on that machine,
with a drop zone and a **Send file** control on each Hosts-tab card.

**oracle being a host is what makes this one mechanism instead of two:** an upload to
the local host lands on the machine Maestro runs on, so "send a file to Maestro" and
"send a file to garage-wsl" are the same route. The local host has no `default_root`,
so it falls back to `$HOME` (override with `MAESTRO_HOST_INBOX`).

From a command line: **`maestro-send FILE [--to HOST]`** (`--list` shows targets).
With no `--to` it goes to the local host — "send this to Maestro" being the obvious
reading. It chunks at 2 MB and resumes from the server's byte count.

It works from **outside the fleet** — no tailnet, no installed token — against the
public URL, which is the case `scp` cannot cover:

```
MAESTRO_URL=https://maestro.lazybrains.com MAESTRO_TOKEN=... maestro-send f --to lithium
```

For that, `POST /api/hosts/:id/upload` and `GET /api/hosts` both accept the shared
agent token as well as a session, since a CLI has no browser session and has to
resolve a host NAME to an id before it can upload.

**Prefer `scp` when you can reach the target**: this route goes client → Maestro →
ssh → host, so bytes cross the wire twice. Its reason to exist is reaching a host you
cannot: no key there, a firewall between, or only Maestro is routable.

`inbox`, not `uploads`: a file sent to a MACHINE is a different thing from an
attachment on an agent's conversation, and sharing the directory name would make them
indistinguishable on disk.

The chunked/resumable receiver now lives in **`services/upload.js`** and is shared by
both the chat-attachment and host routes — previously it was 175 lines inline in
`routes/agents.js`, of which only the first ten were agent-specific. Everything it
protects against is documented at the top of that file; the short version is that
Cloudflare kills any request whose origin has not answered in ~100s, a cut connection
closes a write stream identically to a finished one, and over SSH the bytes in flight
when a pipe dies never landed. Do not reimplement it per route.

### Hosts tab

A third dashboard view beside Projects and Agents (`HostsView.jsx`), because the
machine is the axis the other two cannot show: when something breaks it is usually
per HOST — a box that stopped answering, a disk filling, a plan pinned to one
machine — and answering "what is on garage-wsl right now?" meant reading the host
column of an 88-row agent list.

One card per host in a single-column `space-y-4` stack, matching Projects. Two
columns halved the width available to the inline shell rows, which carry a session
name, host label and action buttons and so truncate badly.

Each card: status dot (the local host is online by definition — the server runs on
it, so `hosts.status` is meaningless there), ssh target, default root, agent counts,
its shells listed inline, and other agents behind a `<details>` so a busy host stays
legible.

**`+ Shell` creates a shell agent on that host and opens it.** Deliberately with
**no `projectId`** — a host shell is a utility, not project work, and forcing one
into a project misfiles it in every other view. The name is suffixed per host
(`lithium-shell`, `lithium-shell-2`); the server independently de-dupes the tmux
*session* name against sessions already on the host, so a new shell can never adopt
a stranger's session.

There is no global add button on this tab: a shell belongs to a specific machine, so
the control lives on the card. The Projects/Agents add button used to be a two-way
ternary, which would otherwise have shown "+ Add Agent" here.

### Per-agent Gemini / Antigravity accounts

Same capability as per-agent Claude identity, built differently because **agy has no
config-dir knob**. It keeps exactly one credential at
`$HOME/.gemini/antigravity-cli/antigravity-oauth-token`, with no `--config-dir`, no
`--account` and no `login` subcommand. Both plausible env vars were tested against
agy 1.4.7 and **neither works**: `ANTIGRAVITY_CONFIG_REL_DIR` relocates nothing, and
`AGY_ACCOUNT` is ignored (a bogus value still authenticated). Overriding **`HOME`**
does work — agy builds a fresh profile there and reports "Please sign in".

So an alternate account is a whole alternate home: `~/.agy-accts/<name>`, created by
`scripts/add-gemini-account.sh <name> [ssh-target]`. Because `HOME` moves everything,
that script repairs what would otherwise break in ways that look unrelated:

- `.ssh`, `.gitconfig`, `.config/git`, `.local/bin` are **symlinked back** to the real
  home, so the agent can still push to git and there is one copy of your keys
- `PATH` is forced back to the real `~/.local/bin` in the launch command — `bash -l`
  sources the new home's profile, which doesn't exist, so otherwise `agy` itself
  stops resolving
- `.gemini` is deliberately **not** shared (that's the point), and neither are
  `.claude`/`.codex` — an agent on this account shouldn't inherit another harness's login

Identity comes from the token file's `id_token_email` plus `auth_method`
(`consumer` vs a Workspace/EDU login — the distinction between a personal and an
institutional quota). `services/geminiAccounts.js` discovers accounts and returns the
**same shape as `accounts.js`**, so one picker drives both: `AccountBadge` keys off an
`ACCOUNT_SHAPE` table (`claudeConfigDir` vs `agyHome`) rather than having a second copy.

`GET /api/agents/accounts?provider=antigravity`, `PATCH {agyHome}`, and
`setAgentActiveAccount(id, dir, field)` records `activeAgyHome` on start so the
"restart to apply" marker works for Gemini too.

### Destructive controls are behind the ⋯ menu

`Start` is inline on an agent row; **`Stop` is not**. They used to be the same
button in the same place, which put the click that kills a session a few pixels from
the chat and terminal icons you reach for constantly — so it got hit by accident.

The asymmetry is deliberate: starting an agent is harmless and worth one click,
while stopping one discards whatever is unsent in its composer and interrupts a turn
mid-flight. A running row therefore shows **no** destructive control at all; Stop and
Delete both live in the menu, and the ⋯ tooltip names what is inside it.

Note `AgentCard.jsx` has its own copy of the old combined Start/Stop button but is
**imported nowhere** — dead since the row layout replaced it. Fix `AgentRow.jsx`.

### Agent state vs. what we can observe

`agents.status` is the last state the monitor managed to OBSERVE, which is not the
same as what is true now. When a host stops answering, the monitor deliberately
leaves its agents alone — a sleeping Mac mini must not flip its still-running agents
to `stopped` — so rows keep reading `idle` indefinitely.

That is right for the data and wrong for the display. After garage-wsl's VM restarted,
eight agents showed a confident green `idle` with no tmux sessions at all, the header
counted them in "(35 ready)", and they sat inside a collapsed section titled **Ready**.
A stale green state is worse than no state: it cannot be told apart from a true one.

So **`unresponsive` is derived, never stored** (`client/src/lib/agentState.js`):
the agent query joins `hosts.status AS host_status`, and an agent whose host is
`offline` while its last-known status was live renders as `unresponsive`, keeping the
last-known value as secondary ("was idle, last seen 3h ago"). A deliberately
`stopped` agent is NOT unresponsive — we aren't failing to observe it, it's just off.

Three surfaces consume it and must stay in agreement:
- `AgentRow` — amber dot, no pulse, an `unresponsive` badge, and a tooltip naming the host
- `Header` — counts are computed on the derived state; unresponsive reported separately
- `Dashboard` — `bucket()` routes them to their own **Unresponsive** section, above
  Ready and never collapsed by default

Watch out: a guard like `if ("agentState" not in src)` matches the unrelated
`agentStates` map in Dashboard.jsx, and a missing import still passes esbuild
(an undefined identifier is just a global reference) and fails only at runtime.

### Per-agent identity

Each agent can run under its own Anthropic account. The mechanism is end-to-end:

- `~/.claude` is the default account; alternates are `~/.claude-accts/<name>`, and
  `accounts.js` **discovers** them from the filesystem rather than any registry.
- Pin one with the account badge in the terminal/chat panel header (`AccountBadge.jsx`),
  which PATCHes `claudeConfigDir` on the agent; `providers.js` turns that into
  `export CLAUDE_CONFIG_DIR=<dir>` in the launch command. A running agent keeps the
  account it started with — the badge shows an amber dot until restarted.
- **Accounts are per host.** oracle and garage-wsl carry all three identities; the mac
  mini and whistler only have the default, so an agent there cannot be pinned to an
  account nobody has signed in on that machine.

An account's credential file **existing is not the same as it being usable.** Access
tokens last about an hour and are refreshed only by a Claude process actually using the
account, so an account nothing has run on goes stale. `listAccounts` therefore reports
`expiresAt`, `tokenExpired`, `hasRefreshToken` and `usable`, and the picker gates on
`usable` — not on `loggedIn`, which it used to, and which offered a 13-day-dead token as
ready. A stale token WITH a refresh token stays selectable and is only flagged, because
pinning an agent to it is exactly how it gets refreshed; without one it needs a person.

**`claude /login` writes to whichever `CLAUDE_CONFIG_DIR` the shell has.** Logging in
from a plain pane to refresh an alternate overwrites `~/.claude` instead — it destroyed
the personal Max credential on garage-wsl and silently moved 16 agents onto a plan that
was at 98%. Always `CLAUDE_CONFIG_DIR=/path/to/acct claude`, and when re-authing both,
do the alternate first.

### Portability notes earned the hard way
- `python3 -c "$(cat <<'EOF' ... EOF)"` is a **parse error in bash 3.2**, which macOS
  still ships and which `/usr/bin/env bash` resolves to on the mac mini. Write the
  script to a temp file with a top-level heredoc instead.
- Backslash escapes inside f-string expressions need python 3.12+. Use `%`-formatting
  in anything that has to run fleet-wide.

## Future Ideas
- Start/stop tmux sessions from UI
- View agent output/logs
- Auto-discover projects from /home/projects/
- Agent task assignment and tracking
- Integration with Claude Code sessions
- Multi-pane terminal layout (like agent-os)
