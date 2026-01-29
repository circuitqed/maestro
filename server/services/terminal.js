import pty from 'node-pty';
import { URL } from 'url';
import { recordActivity } from './agentMonitor.js';

const terminals = new Map();

// Track active connection per session (only one allowed)
// sessionName -> { ws, pty, terminalId }
const activeConnections = new Map();

/**
 * Setup WebSocket server for terminal connections
 */
export function setupTerminalWS(wss) {
  wss.on('connection', async (ws, request) => {
    const url = new URL(request.url, 'http://localhost');
    const sessionName = url.searchParams.get('session');

    if (!sessionName) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session name required' }));
      ws.close();
      return;
    }

    console.log(`Terminal connecting to session: ${sessionName}`);

    // Check if session already has an active connection
    const existingConnection = activeConnections.get(sessionName);
    if (existingConnection) {
      console.log(`Replacing existing connection for session: ${sessionName}`);
      try {
        // Notify old connection that it's being replaced
        if (existingConnection.ws.readyState === existingConnection.ws.OPEN) {
          existingConnection.ws.send(JSON.stringify({
            type: 'replaced',
            message: 'Connection replaced by another tab'
          }));
        }
        // Close old connection's WebSocket (triggers cleanup)
        existingConnection.ws.close();
        // Kill old PTY process
        existingConnection.pty.kill();
        terminals.delete(existingConnection.terminalId);
      } catch (err) {
        console.error('Error closing existing connection:', err);
      }
    }

    // Build environment with UTF-8 support
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    };

    // Create PTY process attached to tmux session
    const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: env.HOME || '/tmp',
      env: env,
      encoding: 'utf8',
    });

    const terminalId = `${sessionName}-${Date.now()}`;
    terminals.set(terminalId, { pty: ptyProcess, ws });

    // Register as active connection for this session
    activeConnections.set(sessionName, { ws, pty: ptyProcess, terminalId });

    // Send terminal output to WebSocket
    // Use base64 encoding to preserve all bytes correctly through JSON
    ptyProcess.onData((data) => {
      // Record activity for agent monitoring
      recordActivity(sessionName);

      if (ws.readyState === ws.OPEN) {
        // Convert to base64 to avoid any encoding issues with JSON
        const base64Data = Buffer.from(data, 'utf8').toString('base64');
        ws.send(JSON.stringify({ type: 'output', data: base64Data, encoding: 'base64' }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal ${terminalId} exited with code ${exitCode}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close();
      }
      terminals.delete(terminalId);
    });

    // Handle incoming WebSocket messages
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());

        switch (msg.type) {
          case 'input':
            ptyProcess.write(msg.data);
            break;

          case 'resize':
            if (msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch (err) {
        console.error('Error processing terminal message:', err);
      }
    });

    // Cleanup on WebSocket close
    ws.on('close', () => {
      console.log(`Terminal ${terminalId} WebSocket closed`);
      ptyProcess.kill();
      terminals.delete(terminalId);
      // Only remove from activeConnections if this connection is still the active one
      const active = activeConnections.get(sessionName);
      if (active && active.terminalId === terminalId) {
        activeConnections.delete(sessionName);
      }
    });

    ws.on('error', (err) => {
      console.error(`Terminal ${terminalId} WebSocket error:`, err);
      ptyProcess.kill();
      terminals.delete(terminalId);
      // Only remove from activeConnections if this connection is still the active one
      const active = activeConnections.get(sessionName);
      if (active && active.terminalId === terminalId) {
        activeConnections.delete(sessionName);
      }
    });

    // Send ready message and request client to send size
    ws.send(JSON.stringify({ type: 'ready', session: sessionName }));

    // Request client to send its current size for proper initialization
    ws.send(JSON.stringify({ type: 'request_resize' }));
  });
}

/**
 * Get count of active terminals
 */
export function getActiveTerminals() {
  return terminals.size;
}
