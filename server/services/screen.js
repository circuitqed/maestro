import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get list of available screen sessions
 */
export async function getScreenSessions() {
  try {
    const { stdout } = await execAsync('screen -ls');
    const lines = stdout.split('\n');
    const sessions = [];

    for (const line of lines) {
      // Match lines like: "	12345.session_name	(Detached)" or "(Attached)"
      const match = line.match(/^\t(\d+)\.([^\t]+)\t\(([^)]+)\)/);
      if (match) {
        sessions.push({
          pid: match[1],
          name: match[2],
          fullName: `${match[1]}.${match[2]}`,
          status: match[3].toLowerCase(),
        });
      }
    }

    return sessions;
  } catch (err) {
    // screen -ls returns exit code 1 when no sessions exist
    if (err.code === 1 && err.stdout && err.stdout.includes('No Sockets found')) {
      return [];
    }
    throw err;
  }
}

/**
 * Check if a screen session exists
 */
export async function sessionExists(sessionName) {
  const sessions = await getScreenSessions();
  return sessions.some((s) => s.name === sessionName || s.fullName === sessionName);
}

/**
 * Create a new screen session
 */
export async function createSession(sessionName, command = '/bin/bash') {
  await execAsync(`screen -dmS ${sessionName} ${command}`);
  return { name: sessionName, created: true };
}

/**
 * Send a command to a screen session
 */
export async function sendToSession(sessionName, command) {
  // Escape the command for screen
  const escaped = command.replace(/"/g, '\\"');
  await execAsync(`screen -S ${sessionName} -X stuff "${escaped}"`);
}
