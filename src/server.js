const express = require('express');
const cors = require('cors');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const url = require('url');
const db = require('./db');
const auth = require('./auth');
const terminalManager = require('./terminal-manager');
const screenManager = require('./screen-manager');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'maestro-secret-change-in-production';

// Initialize auth
auth.initializeAuth();

// Session store using SQLite for persistence across restarts
const sessionDb = new Database(path.join(__dirname, '../data/sessions.db'));

// Session middleware with persistent store
const sessionMiddleware = session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,
      intervalMs: 900000 // Clear expired sessions every 15 min
    }
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 day default
  }
});

app.use(cors());
app.use(express.json());
app.use(sessionMiddleware);

// Public routes (no auth required)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    isDefaultPassword: auth.isDefaultPassword()
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { password, remember } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  const valid = await auth.verifyPassword(password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  req.session.authenticated = true;

  // Extend session if "remember me" is checked
  if (remember) {
    req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/auth/change-password', auth.requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const valid = await auth.verifyPassword(currentPassword);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  await auth.setPassword(newPassword);
  res.json({ success: true });
});

// Serve static files (protected)
app.use((req, res, next) => {
  // Allow public assets
  if (req.path === '/login.html' || req.path.startsWith('/api/auth/')) {
    return next();
  }

  // Check authentication
  if (!req.session || !req.session.authenticated) {
    // For HTML pages, redirect to login
    if (req.accepts('html') && !req.path.startsWith('/api/')) {
      return res.redirect('/login.html');
    }
    // For API, return 401
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// WebSocket setup with session support
const wss = new WebSocketServer({ noServer: true }); // Dashboard notifications
const wssTerminal = new WebSocketServer({ noServer: true }); // Terminal connections

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  sessionMiddleware(request, {}, () => {
    if (!request.session || !request.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname === '/ws/terminal') {
      wssTerminal.handleUpgrade(request, socket, head, (ws) => {
        wssTerminal.emit('connection', ws, request);
      });
    } else {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });
});

// WebSocket connections for real-time updates (dashboard)
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log('Dashboard client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Dashboard client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    clients.delete(ws);
  });
});

// Terminal WebSocket connections
wssTerminal.on('connection', (ws, req) => {
  console.log('Terminal client connected');

  let ptyInfo = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'attach':
          // Attach to a screen session
          if (ptyInfo) {
            terminalManager.kill(ptyInfo.id);
          }

          try {
            ptyInfo = terminalManager.attachToScreen(data.sessionName, {
              cols: data.cols || 80,
              rows: data.rows || 24
            });

            // Set up data handler
            ptyInfo.process.onData((output) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'output', data: output }));
              }
            });

            // Set up exit handler
            ptyInfo.process.onExit(({ exitCode }) => {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  type: 'closed',
                  exitCode,
                  message: `Session ended with code ${exitCode}`
                }));
              }
              ptyInfo = null;
            });

            ws.send(JSON.stringify({
              type: 'attached',
              sessionName: data.sessionName,
              ptyId: ptyInfo.id
            }));

            console.log(`Attached to screen session: ${data.sessionName}`);
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Failed to attach to session: ${err.message}`
            }));
          }
          break;

        case 'shell':
          // Spawn a new shell (no screen)
          if (ptyInfo) {
            terminalManager.kill(ptyInfo.id);
          }

          ptyInfo = terminalManager.spawnShell({
            cols: data.cols || 80,
            rows: data.rows || 24,
            cwd: data.cwd
          });

          ptyInfo.process.onData((output) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'output', data: output }));
            }
          });

          ptyInfo.process.onExit(({ exitCode }) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'closed',
                exitCode
              }));
            }
            ptyInfo = null;
          });

          ws.send(JSON.stringify({
            type: 'shell_started',
            ptyId: ptyInfo.id
          }));
          break;

        case 'input':
          // Send input to PTY
          if (ptyInfo) {
            terminalManager.write(ptyInfo.id, data.data);
          }
          break;

        case 'resize':
          // Resize terminal
          if (ptyInfo) {
            terminalManager.resize(ptyInfo.id, data.cols, data.rows);
          }
          break;

        case 'detach':
          // Detach from session
          if (ptyInfo) {
            terminalManager.kill(ptyInfo.id);
            ptyInfo = null;
          }
          ws.send(JSON.stringify({ type: 'detached' }));
          break;
      }
    } catch (err) {
      console.error('Terminal message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (ptyInfo) {
      terminalManager.kill(ptyInfo.id);
      ptyInfo = null;
    }
    console.log('Terminal client disconnected');
  });

  ws.on('error', (err) => {
    console.error('Terminal WebSocket error:', err);
    if (ptyInfo) {
      terminalManager.kill(ptyInfo.id);
      ptyInfo = null;
    }
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// API Routes

// Get all projects
app.get('/api/projects', (req, res) => {
  const projects = db.getProjects();
  res.json(projects);
});

// Get project colors
app.get('/api/colors', (req, res) => {
  res.json(db.PROJECT_COLORS);
});

// Create a project
app.post('/api/projects', (req, res) => {
  const { name, path: projectPath, description, color } = req.body;
  const project = db.createProject(name, projectPath, description, color);
  broadcast({ type: 'project_created', project });
  db.logActivity('project_created', project.id, null, `Created project: ${name}`);
  res.json(project);
});

// Update a project
app.patch('/api/projects/:id', (req, res) => {
  const project = db.updateProject(req.params.id, req.body);
  broadcast({ type: 'project_updated', project });
  res.json(project);
});

// Get all agents
app.get('/api/agents', (req, res) => {
  const agents = db.getAgents();
  res.json(agents);
});

// Get agents for a project
app.get('/api/projects/:projectId/agents', (req, res) => {
  const agents = db.getAgentsByProject(req.params.projectId);
  res.json(agents);
});

// Create an agent
app.post('/api/agents', (req, res) => {
  const { projectId, name, screenSession, status, config } = req.body;
  const agent = db.createAgent(projectId, name, screenSession, status, config);
  broadcast({ type: 'agent_created', agent });
  db.logActivity('agent_created', projectId, agent.id, `Created agent: ${name}`);
  res.json(agent);
});

// Update agent status
app.patch('/api/agents/:id/status', (req, res) => {
  const { status } = req.body;
  const agent = db.updateAgentStatus(req.params.id, status);
  broadcast({ type: 'agent_status_changed', agent });
  db.logActivity('agent_status_changed', agent.project_id, agent.id, `Status changed to: ${status}`);
  res.json(agent);
});

// Delete an agent
app.delete('/api/agents/:id', (req, res) => {
  const agent = db.getAgent(req.params.id);
  db.deleteAgent(req.params.id);
  broadcast({ type: 'agent_deleted', agentId: req.params.id });
  if (agent) {
    db.logActivity('agent_deleted', agent.project_id, null, `Deleted agent: ${agent.name}`);
  }
  res.json({ success: true });
});

// Delete a project
app.delete('/api/projects/:id', (req, res) => {
  const project = db.getProject(req.params.id);
  db.deleteProject(req.params.id);
  broadcast({ type: 'project_deleted', projectId: req.params.id });
  if (project) {
    db.logActivity('project_deleted', null, null, `Deleted project: ${project.name}`);
  }
  res.json({ success: true });
});

// Get recent activity
app.get('/api/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activity = db.getRecentActivity(limit);
  res.json(activity);
});

// Settings
app.get('/api/settings/:key', (req, res) => {
  const value = db.getSetting(req.params.key);
  res.json({ key: req.params.key, value });
});

app.put('/api/settings/:key', (req, res) => {
  const { value } = req.body;
  db.setSetting(req.params.key, value);
  res.json({ success: true });
});

// Screen session management

// List all screen sessions
app.get('/api/screens', (req, res) => {
  const sessions = screenManager.listSessions();
  res.json(sessions);
});

// Get session info
app.get('/api/screens/:name', (req, res) => {
  const session = screenManager.getSession(req.params.name);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

// Start an agent (create screen session)
app.post('/api/agents/:id/start', (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const project = db.getProject(agent.project_id);
  if (!project || !project.path) {
    return res.status(400).json({ error: 'Project path not configured' });
  }

  const sessionName = agent.screen_session || `${project.name}-${agent.name}`;

  // Check if already running
  if (screenManager.sessionExists(sessionName)) {
    // Update status to running
    const updated = db.updateAgentStatus(agent.id, 'running');
    broadcast({ type: 'agent_status_changed', agent: updated });
    return res.json({ success: true, message: 'Session already running', agent: updated });
  }

  // Get custom command from agent config if set
  let config = {};
  try {
    config = agent.config ? JSON.parse(agent.config) : {};
  } catch (e) {}

  const command = config.startCommand || 'claude --dangerously-skip-permissions';
  const workingDir = config.workingDirectory || project.path;

  const result = screenManager.createSession(sessionName, workingDir, command);

  if (result.success) {
    // Update agent with session name if it wasn't set
    if (!agent.screen_session) {
      db.updateProject(agent.id, { screen_session: sessionName });
    }

    const updated = db.updateAgentStatus(agent.id, 'running');
    broadcast({ type: 'agent_status_changed', agent: updated });
    db.logActivity('agent_started', agent.project_id, agent.id, `Started agent: ${agent.name}`);
    res.json({ success: true, sessionName, agent: updated });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Stop an agent (kill screen session)
app.post('/api/agents/:id/stop', (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  if (!agent.screen_session) {
    // Just update status
    const updated = db.updateAgentStatus(agent.id, 'stopped');
    broadcast({ type: 'agent_status_changed', agent: updated });
    return res.json({ success: true, agent: updated });
  }

  const result = screenManager.killSession(agent.screen_session);

  if (result.success) {
    const updated = db.updateAgentStatus(agent.id, 'stopped');
    broadcast({ type: 'agent_status_changed', agent: updated });
    db.logActivity('agent_stopped', agent.project_id, agent.id, `Stopped agent: ${agent.name}`);
    res.json({ success: true, agent: updated });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Send Ctrl+C to an agent
app.post('/api/agents/:id/interrupt', (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent || !agent.screen_session) {
    return res.status(404).json({ error: 'Agent or session not found' });
  }

  const result = screenManager.sendCtrlC(agent.screen_session);
  res.json(result);
});

// Git integration - get git status for a project
app.get('/api/projects/:id/git', (req, res) => {
  const project = db.getProject(req.params.id);
  if (!project || !project.path) {
    return res.status(404).json({ error: 'Project not found or path not set' });
  }

  try {
    const { execSync } = require('child_process');
    const cwd = project.path;

    // Check if it's a git repo
    try {
      execSync('git rev-parse --git-dir', { cwd, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      return res.json({ isGitRepo: false });
    }

    // Get branch name
    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
    } catch {}

    // Get uncommitted changes count
    let uncommittedChanges = 0;
    try {
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', stdio: 'pipe' });
      uncommittedChanges = status.split('\n').filter(line => line.trim()).length;
    } catch {}

    // Get last commit
    let lastCommit = null;
    try {
      const log = execSync('git log -1 --format="%H|%s|%cI"', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
      const [hash, message, date] = log.split('|');
      lastCommit = {
        hash: hash.substring(0, 7),
        message: message.length > 50 ? message.substring(0, 50) + '...' : message,
        date
      };
    } catch {}

    // Get remote URL and convert to web URL
    let remoteUrl = null;
    try {
      const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
      // Convert git URLs to web URLs
      // git@github.com:user/repo.git -> https://github.com/user/repo
      // https://github.com/user/repo.git -> https://github.com/user/repo
      if (remote.includes('github.com')) {
        remoteUrl = remote
          .replace(/^git@github\.com:/, 'https://github.com/')
          .replace(/\.git$/, '');
      } else if (remote.includes('gitlab.com')) {
        remoteUrl = remote
          .replace(/^git@gitlab\.com:/, 'https://gitlab.com/')
          .replace(/\.git$/, '');
      } else if (remote.startsWith('https://')) {
        remoteUrl = remote.replace(/\.git$/, '');
      }
    } catch {}

    res.json({
      isGitRepo: true,
      branch,
      uncommittedChanges,
      lastCommit,
      remoteUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Periodic status sync
const STATUS_SYNC_INTERVAL = 10000; // 10 seconds

function syncStatuses() {
  try {
    const agents = db.getAgents();
    screenManager.syncAgentStatuses(agents, db, broadcast);
  } catch (err) {
    console.error('Status sync error:', err);
  }
}

// Run initial sync and set up interval
setTimeout(syncStatuses, 2000);
setInterval(syncStatuses, STATUS_SYNC_INTERVAL);

server.listen(PORT, () => {
  console.log(`Maestro running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});

module.exports = { app, server, wss, broadcast };
