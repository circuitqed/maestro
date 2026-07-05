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
| GET | /api/agents/:id/transcript/meta | Whether a transcript file was located `{available, sessionId}` |
| DELETE | /api/agents/:id | Delete agent |
| GET | /api/hosts | List hosts |
| POST | /api/hosts | Add remote host (admin) |
| DELETE | /api/hosts/:id | Delete host (admin; not local, not if agents reference it) |
| POST | /api/hosts/:id/test | Test connectivity (runs `tmux -V`, persists status) |

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

## Future Ideas
- Start/stop tmux sessions from UI
- View agent output/logs
- Auto-discover projects from /home/projects/
- Agent task assignment and tracking
- Integration with Claude Code sessions
- Multi-pane terminal layout (like agent-os)
