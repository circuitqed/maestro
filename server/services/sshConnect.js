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
import { execOnHost, isHostUnreachable } from './hosts.js';
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
export async function connectionStatus(conn, host = null) {
  // The master socket is per-host: one opened on oracle does nothing for an agent on
  // garage-wsl, so every check runs where the agent actually is.
  try {
    await execOnHost(host, `ssh -O check ${conn.host} 2>&1`);
    return { connected: true, available: true };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    // "Master running (pid=…)" exits 0; anything else means no usable socket.
    if (/Master running/i.test(out)) return { connected: true, available: true };
    // Classify on the MESSAGE before the exit code: `ssh -O check` exits 255 both when
    // there is no master socket and when the host itself is unreachable, and
    // isHostUnreachable only sees the code — which made a correctly configured
    // garage-wsl look like it had no Sherlock at all.
    if (/control socket connect|no such file or directory|control socket.*not found/i.test(out)) {
      return { connected: false, available: true };
    }
    // A host with no `Host sherlock` in its ssh config: nothing to offer, hide the UI.
    if (/could not resolve hostname|no such host|hostname contains invalid/i.test(out)) {
      return { connected: false, available: false };
    }
    if (isHostUnreachable(err)) return { connected: false, available: false, hostDown: true };
    return { connected: false, available: true };
  }
}

/** Start the login in its own session, or report the one already in progress. */
export async function beginConnect(conn, host = null) {
  if (await sessionExists(conn.session, host)) {
    return { started: false, alreadyRunning: true };
  }
  await createSession(conn.session, null, conn.command, host);
  return { started: true };
}

export async function connectionPane(conn, host = null) {
  if (!(await sessionExists(conn.session, host))) return null;
  return capturePane(conn.session, host);
}

export async function connectionInput(conn, text, host = null) {
  if (!(await sessionExists(conn.session, host))) throw new Error('No login in progress');
  // verify:false — ssh never echoes a password, so there is nothing to confirm; with
  // verification on, the Enter is withheld and the login just sits there.
  return sendText(conn.session, text, host, { verify: false });
}

export async function connectionKeys(conn, keys, host = null) {
  if (!(await sessionExists(conn.session, host))) throw new Error('No login in progress');
  return sendKeys(conn.session, keys, host);
}

/** Drop the master and clean up the login session. */
export async function disconnect(conn, host = null) {
  try {
    await execOnHost(host, `ssh -O exit ${conn.host} 2>&1`);
  } catch {
    /* no master to drop */
  }
  try {
    await killSession(conn.session, host);
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
