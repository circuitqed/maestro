import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import agentsRoutes from './routes/agents.js';
import connectionRoutes from './routes/connections.js';
import hostsRoutes from './routes/hosts.js';
import agentApiRoutes from './routes/agentApi.js';
import swarmApiRoutes from './routes/swarmApi.js';
import swarmReportRoutes from './routes/swarmReport.js';
import swarmsRoutes from './routes/swarms.js';
import { initSwarmTables } from './services/swarm.js';
import { startSwarmRunner, initSwarmItems } from './services/swarmRunner.js';
import { initTaskTables } from './services/tasks.js';
import { startTaskRunner } from './services/taskRunner.js';
import { ensureAgentApiToken } from './services/agentToken.js';
import { setupTerminalWS } from './services/terminal.js';
import { setupTranscriptWS } from './services/transcript.js';
import { initDb, getUserCount } from './services/db.js';
import SQLiteStore from './services/sessionStore.js';
import { startMonitoring, onStateChange, getAllAgentStates, registerAgent } from './services/agentMonitor.js';
import { startHarnessWatch } from './services/harnessWatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Session configuration with SQLite store for persistence
const sessionParser = session({
  store: new SQLiteStore({
    ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
  }),
  secret: process.env.SESSION_SECRET || 'maestro-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// Middleware
// 4mb, not the 100kb default: swarmApi advertises up to 500 items x 4000 chars,
// so a legitimate batch returned a 413 HTML error page that the CLI could not
// parse and reported as "Maestro is down".
app.use(express.json({ limit: '4mb' }));
app.use(sessionParser);

// API Routes
app.use('/api/agent', agentApiRoutes);  // called by agents themselves, token-authed
app.use('/api/agent', swarmApiRoutes);  // swarm spawn/status, same agent identity
// NOT behind requireAuth: a worker has no session, only a one-shot per-worker
// token. Mounted at its own exact path -- the router also answers '/', so
// mounting it at the root would have made it intercept POST / as well.
app.use('/api/swarm-report', swarmReportRoutes);
app.use('/api/swarms', swarmsRoutes);  // browser-facing
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/hosts', hostsRoutes);

// Serve static files in production.
// Content-hashed assets (Vite emits /assets/index-<hash>.js) are safe to cache
// forever; index.html must always revalidate so a new deploy is picked up
// immediately instead of the browser clinging to a stale bundle reference.
const publicPath = path.join(__dirname, 'public');
app.use(
  express.static(publicPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicPath, 'index.html'));
  }
});

// WebSocket server for terminal
const terminalWss = new WebSocketServer({ noServer: true });

// WebSocket server for read-only agent transcript (pretty chat view)
const transcriptWss = new WebSocketServer({ noServer: true });

// WebSocket server for notifications
const notifyWss = new WebSocketServer({ noServer: true });
const notifyClients = new Set();

server.on('upgrade', (request, socket, head) => {
  sessionParser(request, {}, () => {
    // Check authentication for WebSocket
    const userCount = getUserCount();
    if (userCount > 0 && !request.session?.user_id) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (request.url.startsWith('/ws/terminal')) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit('connection', ws, request);
      });
    } else if (request.url.startsWith('/ws/transcript')) {
      transcriptWss.handleUpgrade(request, socket, head, (ws) => {
        transcriptWss.emit('connection', ws, request);
      });
    } else if (request.url.startsWith('/ws/notifications')) {
      notifyWss.handleUpgrade(request, socket, head, (ws) => {
        notifyWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
});

setupTerminalWS(terminalWss);
setupTranscriptWS(transcriptWss);

// Setup notifications WebSocket
notifyWss.on('connection', (ws) => {
  console.log('Notifications client connected');
  notifyClients.add(ws);

  // Send current states on connect
  ws.send(JSON.stringify({
    type: 'initial_states',
    states: getAllAgentStates(),
  }));

  ws.on('close', () => {
    notifyClients.delete(ws);
    console.log('Notifications client disconnected');
  });

  ws.on('error', (err) => {
    console.error('Notifications WebSocket error:', err);
    notifyClients.delete(ws);
  });
});

// Broadcast agent state changes to all notification clients
onStateChange((event) => {
  const message = JSON.stringify(event);
  for (const client of notifyClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
});

// Initialize database and start server
const PORT = process.env.PORT || 5000;

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Maestro server running on port ${PORT}`);
    // Start monitoring agents for idle/busy state
    startMonitoring(2000);
    // Nightly: reload agents left running an older CLI than the one installed.
    startHarnessWatch({ registerAgent });
      // Agent-to-agent assignments: deliver queued work, report results back.
      initTaskTables();
      ensureAgentApiToken();
      startTaskRunner(5000);
      // Swarms. initSwarmItems is separate because swarm.js owns the money tables
      // and the runner owns the work queue.
      initSwarmTables();
      if (typeof initSwarmItems === 'function') initSwarmItems();
      startSwarmRunner(5000);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
