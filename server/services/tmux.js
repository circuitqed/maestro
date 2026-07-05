import { execOnHost, shellQuote } from './hosts.js';

/**
 * Get list of available tmux sessions
 * @param {object|null} host - Host row (null => local)
 */
export async function getTmuxSessions(host = null) {
  try {
    const { stdout } = await execOnHost(host, 'tmux list-sessions -F "#{session_name}:#{session_attached}"');
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
export async function sessionExists(sessionName, host = null) {
  try {
    await execOnHost(host, `tmux has-session -t ${shellQuote(sessionName)} 2>/dev/null`);
    return true;
  } catch (err) {
    // tmux has-session exits 1 when the session/server genuinely doesn't exist.
    // Anything else (ssh 255, ConnectTimeout, execFile timeout) means the host
    // state is unknown — surface it so callers don't treat "unreachable" as "gone".
    if (err.code === 1) return false;
    throw err;
  }
}

/**
 * Create a new tmux session and optionally run a command
 * @param {string} sessionName - Name for the tmux session
 * @param {string} workingDir - Working directory for the session
 * @param {string} command - Command to run in the session
 * @param {object|null} host - Host row (null => local)
 */
export async function createSession(sessionName, workingDir = null, command = null, host = null) {
  // Check if session already exists
  if (await sessionExists(sessionName, host)) {
    return { name: sessionName, created: false, message: 'Session already exists' };
  }

  // Build the tmux command
  let tmuxCmd = `tmux new-session -d -s ${shellQuote(sessionName)}`;

  if (workingDir) {
    tmuxCmd += ` -c ${shellQuote(workingDir)}`;
  }

  if (command) {
    // Run command with exec bash fallback so session stays open
    tmuxCmd += ` ${shellQuote(`${command}; exec bash`)}`;
  }

  await execOnHost(host, tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Start a provider agent session with a given command
 * @param {string} sessionName - Name for the tmux session
 * @param {string} command - Shell command to run (e.g. "bash -lc 'claude --dangerously-skip-permissions; exec bash'")
 * @param {string} workingDir - Project path as working directory
 * @param {object|null} host - Host row (null => local)
 */
export async function startProviderSession(sessionName, command, workingDir = null, host = null) {
  if (await sessionExists(sessionName, host)) {
    return { name: sessionName, created: false, alreadyRunning: true };
  }

  let tmuxCmd = `tmux new-session -d -s ${shellQuote(sessionName)}`;

  if (workingDir) {
    tmuxCmd += ` -c ${shellQuote(workingDir)}`;
  }

  tmuxCmd += ` ${shellQuote(command)}`;

  await execOnHost(host, tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Start a Claude agent session (backward compatibility)
 */
export async function startAgentSession(sessionName, workingDir = null) {
  const command = "bash -lc '/home/dave/.local/bin/claude --dangerously-skip-permissions; exec bash'";
  return startProviderSession(sessionName, command, workingDir);
}

/**
 * Kill a tmux session
 */
export async function killSession(sessionName, host = null) {
  try {
    await execOnHost(host, `tmux kill-session -t ${shellQuote(sessionName)}`);
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
export async function sendKeys(sessionName, keys, host = null) {
  await execOnHost(host, `tmux send-keys -t ${shellQuote(sessionName)} "${keys}"`);
}
