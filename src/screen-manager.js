const { execSync, spawn } = require('child_process');

/**
 * List all active screen sessions
 */
function listSessions() {
  try {
    const output = execSync('screen -ls', { encoding: 'utf-8', timeout: 5000 });
    const sessions = [];

    // Parse screen -ls output
    // Format: "12345.session-name\t(Attached)" or "(Detached)"
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\.([^\t]+)\t\(([^)]+)\)/);
      if (match) {
        sessions.push({
          pid: match[1],
          name: match[2],
          state: match[3].toLowerCase() // 'attached' or 'detached'
        });
      }
    }

    return sessions;
  } catch (err) {
    // screen -ls returns exit code 1 when no sessions exist
    if (err.status === 1 && err.stdout && err.stdout.includes('No Sockets found')) {
      return [];
    }
    console.error('Failed to list screen sessions:', err.message);
    return [];
  }
}

/**
 * Check if a specific screen session exists
 */
function sessionExists(sessionName) {
  const sessions = listSessions();
  return sessions.some(s => s.name === sessionName);
}

/**
 * Get session info by name
 */
function getSession(sessionName) {
  const sessions = listSessions();
  return sessions.find(s => s.name === sessionName);
}

/**
 * Create a new screen session and start claude code
 */
function createSession(sessionName, workingDir, command = null) {
  if (sessionExists(sessionName)) {
    return { success: false, error: 'Session already exists' };
  }

  const defaultCommand = 'claude --dangerously-skip-permissions';
  const cmd = command || defaultCommand;

  try {
    // Create a detached screen session that runs the command
    // Using bash -c to change directory and run command, with exec bash to keep session alive
    const fullCommand = `cd "${workingDir}" && ${cmd}; exec bash`;

    execSync(`screen -dmS "${sessionName}" bash -c '${fullCommand}'`, {
      encoding: 'utf-8',
      timeout: 10000
    });

    // Verify session was created
    if (sessionExists(sessionName)) {
      return { success: true, sessionName };
    } else {
      return { success: false, error: 'Session failed to start' };
    }
  } catch (err) {
    console.error('Failed to create screen session:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Stop/kill a screen session
 */
function killSession(sessionName) {
  try {
    execSync(`screen -S "${sessionName}" -X quit`, {
      encoding: 'utf-8',
      timeout: 5000
    });
    return { success: true };
  } catch (err) {
    // Session might already be dead
    if (!sessionExists(sessionName)) {
      return { success: true };
    }
    console.error('Failed to kill screen session:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a command to a screen session (without attaching)
 */
function sendToSession(sessionName, text) {
  try {
    // Use screen -S <name> -X stuff to send text
    // Need to escape the text and add newline
    execSync(`screen -S "${sessionName}" -X stuff "${text}\n"`, {
      encoding: 'utf-8',
      timeout: 5000
    });
    return { success: true };
  } catch (err) {
    console.error('Failed to send to screen session:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send Ctrl+C to a screen session
 */
function sendCtrlC(sessionName) {
  try {
    execSync(`screen -S "${sessionName}" -X stuff $'\\003'`, {
      encoding: 'utf-8',
      timeout: 5000,
      shell: '/bin/bash'
    });
    return { success: true };
  } catch (err) {
    console.error('Failed to send Ctrl+C:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Map session states to agent status
 */
function sessionStateToAgentStatus(sessionState) {
  if (!sessionState) return 'stopped';
  // If session exists, it's at least "running" (may be attached or detached)
  return 'running';
}

/**
 * Sync agent statuses with actual screen sessions
 */
function syncAgentStatuses(agents, db, broadcast) {
  const sessions = listSessions();
  const sessionMap = new Map(sessions.map(s => [s.name, s]));

  for (const agent of agents) {
    if (!agent.screen_session) continue;

    const session = sessionMap.get(agent.screen_session);
    const actualStatus = session ? 'running' : 'stopped';

    // Update if status differs
    if (agent.status !== actualStatus && agent.status !== 'idle') {
      const updated = db.updateAgentStatus(agent.id, actualStatus);
      if (broadcast) {
        broadcast({ type: 'agent_status_changed', agent: updated });
      }
      console.log(`Auto-updated agent "${agent.name}" status: ${agent.status} -> ${actualStatus}`);
    }
  }
}

module.exports = {
  listSessions,
  sessionExists,
  getSession,
  createSession,
  killSession,
  sendToSession,
  sendCtrlC,
  sessionStateToAgentStatus,
  syncAgentStatuses
};
