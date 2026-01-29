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
| GET | /api/agents/sessions | List available tmux sessions |
| POST | /api/agents | Create agent |
| PATCH | /api/agents/:id/status | Update status |
| DELETE | /api/agents/:id | Delete agent |

## WebSocket Protocol

Connect to: `ws://host/ws/terminal?session=<tmux-session-name>`

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

## Terminal UX

- **Desktop (>= 768px):** Full-height resizable side panel using react-resizable-panels
- **Mobile (< 768px):** Full-screen modal overlay

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
```

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

## Future Ideas
- Start/stop tmux sessions from UI
- View agent output/logs
- Auto-discover projects from /home/projects/
- Agent task assignment and tracking
- Integration with Claude Code sessions
- Multi-pane terminal layout (like agent-os)
