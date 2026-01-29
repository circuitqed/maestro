import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get list of available tmux sessions
 */
export async function getTmuxSessions() {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}:#{session_attached}"');
    const lines = stdout.trim().split('\n').filter(Boolean);

    return lines.map((line) => {
      const [name, attached] = line.split(':');
      return {
        name,
        status: attached === '1' ? 'attached' : 'detached',
      };
    });
  } catch (err) {
    // tmux returns exit code 1 when no sessions exist
    if (err.code === 1 || err.message.includes('no server running')) {
      return [];
    }
    throw err;
  }
}

/**
 * Check if a tmux session exists
 */
export async function sessionExists(sessionName) {
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session and optionally run a command
 * @param {string} sessionName - Name for the tmux session
 * @param {string} workingDir - Working directory for the session
 * @param {string} command - Command to run in the session
 */
export async function createSession(sessionName, workingDir = null, command = null) {
  // Check if session already exists
  if (await sessionExists(sessionName)) {
    return { name: sessionName, created: false, message: 'Session already exists' };
  }

  // Build the tmux command
  let tmuxCmd = `tmux new-session -d -s "${sessionName}"`;

  if (workingDir) {
    tmuxCmd += ` -c "${workingDir}"`;
  }

  if (command) {
    // Run command with exec bash fallback so session stays open
    tmuxCmd += ` "${command}; exec bash"`;
  }

  await execAsync(tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Start a Claude agent session
 * @param {string} sessionName - Name for the tmux session
 * @param {string} workingDir - Project path as working directory
 */
export async function startAgentSession(sessionName, workingDir = null) {
  // Check if session already exists
  if (await sessionExists(sessionName)) {
    return { name: sessionName, created: false, alreadyRunning: true };
  }

  // Find claude binary - check common paths
  const claudePaths = [
    '/home/dave/.local/bin/claude',
    '/usr/local/bin/claude',
    '~/.local/bin/claude',
  ];

  // Build the tmux command to run claude with full path
  // Use bash -l to get login shell environment, then run claude
  let tmuxCmd = `tmux new-session -d -s "${sessionName}"`;

  if (workingDir) {
    tmuxCmd += ` -c "${workingDir}"`;
  }

  // Run claude with full path, fall back to bash if it exits
  // Use bash -lc to source profile and get proper PATH
  const claudeCmd = claudePaths[0]; // Use known path
  tmuxCmd += ` "bash -lc '${claudeCmd} --dangerously-skip-permissions; exec bash'"`;

  await execAsync(tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Kill a tmux session
 */
export async function killSession(sessionName) {
  try {
    await execAsync(`tmux kill-session -t "${sessionName}"`);
    return { name: sessionName, killed: true };
  } catch (err) {
    if (err.message.includes('session not found') || err.message.includes("can't find session")) {
      return { name: sessionName, killed: false, message: 'Session not found' };
    }
    throw err;
  }
}

/**
 * Send keys to a tmux session
 */
export async function sendKeys(sessionName, keys) {
  await execAsync(`tmux send-keys -t "${sessionName}" "${keys}"`);
}
