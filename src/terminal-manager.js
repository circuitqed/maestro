const pty = require('node-pty');
const os = require('os');

// Track active PTY sessions
const activePtys = new Map();

const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

/**
 * Create a new PTY that attaches to a screen session
 */
function attachToScreen(sessionName, options = {}) {
  const { cols = 80, rows = 24 } = options;

  // Create a unique ID for this PTY connection
  const ptyId = `${sessionName}-${Date.now()}`;

  // First check if the screen session exists
  // We'll spawn screen -r which will attach to the session
  const ptyProcess = pty.spawn('screen', ['-r', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || '/root',
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const ptyInfo = {
    id: ptyId,
    sessionName,
    process: ptyProcess,
    cols,
    rows,
    createdAt: new Date()
  };

  activePtys.set(ptyId, ptyInfo);

  return ptyInfo;
}

/**
 * Create a new screen session with claude code
 */
function createScreenSession(sessionName, workingDir, command = 'claude --dangerously-skip-permissions') {
  const fullCommand = `cd "${workingDir}" && ${command}`;

  // Create detached screen session
  const { execSync } = require('child_process');
  try {
    execSync(`screen -dmS "${sessionName}" bash -c '${fullCommand}; exec bash'`, {
      stdio: 'ignore'
    });
    return { success: true, sessionName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Spawn a raw shell PTY (no screen)
 */
function spawnShell(options = {}) {
  const { cols = 80, rows = 24, cwd } = options;

  const ptyId = `shell-${Date.now()}`;

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || process.env.HOME || '/root',
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const ptyInfo = {
    id: ptyId,
    sessionName: null,
    process: ptyProcess,
    cols,
    rows,
    createdAt: new Date()
  };

  activePtys.set(ptyId, ptyInfo);

  return ptyInfo;
}

/**
 * Resize a PTY
 */
function resize(ptyId, cols, rows) {
  const ptyInfo = activePtys.get(ptyId);
  if (!ptyInfo) return false;

  try {
    ptyInfo.process.resize(cols, rows);
    ptyInfo.cols = cols;
    ptyInfo.rows = rows;
    return true;
  } catch (err) {
    console.error('Failed to resize PTY:', err);
    return false;
  }
}

/**
 * Write data to a PTY
 */
function write(ptyId, data) {
  const ptyInfo = activePtys.get(ptyId);
  if (!ptyInfo) return false;

  try {
    ptyInfo.process.write(data);
    return true;
  } catch (err) {
    console.error('Failed to write to PTY:', err);
    return false;
  }
}

/**
 * Kill/close a PTY
 */
function kill(ptyId) {
  const ptyInfo = activePtys.get(ptyId);
  if (!ptyInfo) return false;

  try {
    ptyInfo.process.kill();
    activePtys.delete(ptyId);
    return true;
  } catch (err) {
    console.error('Failed to kill PTY:', err);
    return false;
  }
}

/**
 * Get info about a PTY
 */
function get(ptyId) {
  return activePtys.get(ptyId);
}

/**
 * List all active PTYs
 */
function list() {
  return Array.from(activePtys.values()).map(p => ({
    id: p.id,
    sessionName: p.sessionName,
    cols: p.cols,
    rows: p.rows,
    createdAt: p.createdAt
  }));
}

/**
 * Clean up all PTYs
 */
function cleanup() {
  for (const [ptyId, ptyInfo] of activePtys) {
    try {
      ptyInfo.process.kill();
    } catch (err) {
      // Ignore errors during cleanup
    }
    activePtys.delete(ptyId);
  }
}

// Clean up on process exit
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit();
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit();
});

module.exports = {
  attachToScreen,
  createScreenSession,
  spawnShell,
  resize,
  write,
  kill,
  get,
  list,
  cleanup
};
