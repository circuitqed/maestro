import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import agentsRoutes from './routes/agents.js';
import { setupTerminalWS } from './services/terminal.js';
import { initDb } from './services/db.js';
import SQLiteStore from './services/sessionStore.js';
import { startMonitoring, onStateChange, getAllAgentStates, registerAgent } from './services/agentMonitor.js';

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
app.use(express.json());
app.use(sessionParser);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/agents', agentsRoutes);

// Serve static files in production
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  }
});

// WebSocket server for terminal
const terminalWss = new WebSocketServer({ noServer: true });

// WebSocket server for notifications
const notifyWss = new WebSocketServer({ noServer: true });
const notifyClients = new Set();

server.on('upgrade', (request, socket, head) => {
  sessionParser(request, {}, () => {
    // Check authentication for WebSocket
    if (!request.session?.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (request.url.startsWith('/ws/terminal')) {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit('connection', ws, request);
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
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
