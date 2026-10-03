/**
 * Interactive SSH logins, driven from the chat instead of a terminal.
 *
 * Sherlock has no public-key auth — every connection wants a password AND a Duo
 * second factor. Agents cannot do that themselves: Claude's Bash tool is not
 * interactive, so an `ssh sherlock` inside an agent just fails with "Permission
 * denied". What makes it work at all is ControlMaster: once a human establishes one
 * master connection, every later ssh multiplexes over that socket for 12h with no
 * auth, including the agents'.
 *
 * So the master has to be created by a person — and the only reason that meant
 * opening a terminal is that nothing surfaced the prompts. Run the login inside its
 * own tmux session and the password prompt, the Duo menu and the "pushed a login
 * request" wait are all just pane text, which the chat can already render and type
 * into.
 *
 * The password is pasted into the pane the same way chat messages are (set-buffer /
 * paste-buffer -d, which deletes the buffer after use). ssh does not echo it, so it
 * never appears in the pane, and nothing here writes it to a log or a transcript.
 */
import { execOnHost } from './hosts.js';
import { createSession, sessionExists, killSession, capturePane, sendText, sendKeys } from './tmux.js';

// Hosts that need an interactive login. Keyed by id so the routes stay opaque to
// which host is which; `host` is an ssh_config alias, so all the ControlMaster
// settings (socket path, 12h persist) come from there rather than being repeated.
const CONNECTIONS = {
  sherlock: {
    id: 'sherlock',
    label: 'Sherlock',
    host: 'sherlock',
    // -M master, -N no command: just hold the socket open.
    command: 'ssh -M -N sherlock',
    session: 'conn-sherlock',
    hint: 'Stanford password, then approve the Duo push on your phone.',
  },
};

export function listConnections() {
  return Object.values(CONNECTIONS).map(({ id, label, hint }) => ({ id, label, hint }));
}

export function getConnection(id) {
  return CONNECTIONS[id] || null;
}

/**
 * Is the multiplexed master alive? `ssh -O check` asks the socket itself, so this is
 * true exactly when an agent's ssh would succeed without auth.
 */
export async function connectionStatus(conn) {
  try {
    await execOnHost(null, `ssh -O check ${conn.host} 2>&1`);
    return { connected: true };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    // "Master running (pid=…)" exits 0; anything else means no usable socket.
    return { connected: /Master running/i.test(out), detail: null };
  }
}

/** Start the login in its own session, or report the one already in progress. */
export async function beginConnect(conn) {
  if (await sessionExists(conn.session, null)) {
    return { started: false, alreadyRunning: true };
  }
  await createSession(conn.session, null, conn.command, null);
  return { started: true };
}

export async function connectionPane(conn) {
  if (!(await sessionExists(conn.session, null))) return null;
  return capturePane(conn.session, null);
}

export async function connectionInput(conn, text) {
  if (!(await sessionExists(conn.session, null))) throw new Error('No login in progress');
  return sendText(conn.session, text, null);
}

export async function connectionKeys(conn, keys) {
  if (!(await sessionExists(conn.session, null))) throw new Error('No login in progress');
  return sendKeys(conn.session, keys, null);
}

/** Drop the master and clean up the login session. */
export async function disconnect(conn) {
  try {
    await execOnHost(null, `ssh -O exit ${conn.host} 2>&1`);
  } catch {
    /* no master to drop */
  }
  try {
    await killSession(conn.session, null);
  } catch {
    /* no session */
  }
  return { ok: true };
}

/**
 * Tidy up once the master is established: the `ssh -M -N` process keeps running to
 * hold the socket, but it no longer needs a tmux session wrapped around it... except
 * it does — killing the session kills the ssh, and with it the master. So the session
 * is kept, and this only reports that the login finished.
 */
export async function connectionReady(conn) {
  const { connected } = await connectionStatus(conn);
  return connected;
}
