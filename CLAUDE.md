# Maestro - Agent Orchestrator

Web-based dashboard for managing multiple projects and their Claude agents.

**Dashboard URL:** http://localhost:7007

## Tech Stack
- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Real-time**: WebSockets for live updates
- **Frontend**: Vanilla HTML/CSS/JS

## Project Structure
```
/home/projects/maestro/
├── src/
│   ├── server.js    # Express server + WebSocket
│   └── db.js        # SQLite database layer
├── public/
│   └── index.html   # Dashboard UI
├── data/
│   └── maestro.db   # SQLite database (auto-created)
├── docker-compose.yml
├── Dockerfile
├── start-maestro.sh # Screen session launcher
└── package.json
```

## Running with Docker

The container is named `maestro` and runs on port 7007.

```bash
# Check status
docker ps --filter name=maestro

# View logs
docker logs -f maestro

# Restart (after code changes)
docker restart maestro

# Stop
docker stop maestro

# Start (if stopped)
docker start maestro

# Full rebuild (if Dockerfile or dependencies change)
docker stop maestro && docker rm maestro
docker build -t maestro /home/projects/maestro
docker run -d --name maestro -p 7007:5000 \
  -v /home/projects/maestro:/app \
  -v maestro_node_modules:/app/node_modules \
  -v /home/projects/maestro/data:/app/data \
  --restart unless-stopped maestro
```

## Volume Mapping
| Host | Container | Purpose |
|------|-----------|---------|
| `/home/projects/maestro` | `/app` | Source code (live sync) |
| Named: `maestro_node_modules` | `/app/node_modules` | Dependencies (Docker-only) |
| `/home/projects/maestro/data` | `/app/data` | SQLite DB (persisted) |

**Note:** Frontend changes (`public/`) are instant (refresh browser). Backend changes (`src/`) require `docker restart maestro`.

## Local Development (without Docker)
```bash
npm install
npm run dev   # Uses --watch for auto-reload
```

## Port
- **7007** (host) → 5000 (container)

## API Endpoints
- `GET /api/projects` - List all projects
- `POST /api/projects` - Create project `{name, path, description}`
- `DELETE /api/projects/:id` - Delete project
- `GET /api/agents` - List all agents
- `GET /api/projects/:projectId/agents` - List agents for project
- `POST /api/agents` - Create agent `{projectId, name, screenSession, status}`
- `PATCH /api/agents/:id/status` - Update agent status `{status: running|stopped|idle}`
- `DELETE /api/agents/:id` - Delete agent

## Current Projects Tracked
- deep-blue-brawl (port 7847)
- moto-game (port 7848)
- razzle (port 7492, multi-agent)
- birdbrain
- mafia
- maestro (this project, port 7007)

## Future Ideas
- Start/stop screen sessions from UI
- View agent output/logs
- Auto-discover projects from /home/projects/
- Agent task assignment and tracking
- Integration with Claude Code sessions
