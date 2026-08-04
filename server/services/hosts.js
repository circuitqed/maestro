import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateHostStatus } from './db.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Default PATH prefix for remote hosts (e.g. macOS where non-interactive
// SSH gets a bare PATH and tmux/claude live in /opt/homebrew/bin)
export const DEFAULT_PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin';

// Ensure the SSH ControlMaster socket directory exists
try {
  fs.mkdirSync(path.join(os.homedir(), '.ssh', 'sockets'), { recursive: true, mode: 0o700 });
} catch (e) { /* best effort */ }

/**
 * A host is remote when it has an ssh_target; NULL => local
 */
export function isRemote(host) {
  return !!(host && host.ssh_target);
}

/**
 * Session names get spliced into shell commands, so restrict them strictly
 */
export function isValidSessionName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name || '');
}

/**
 * Single-quote a string for POSIX shells
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Base ssh args: batch mode, short timeout, connection multiplexing
 */
export function sshBaseArgs(host) {
  const controlPath = path.join(os.homedir(), '.ssh', 'sockets', 'maestro-%r@%h-%p');
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ControlPersist=600',
  ];
}

/**
 * Prefix a remote command with a PATH export so tmux/claude resolve
 * under the bare non-interactive SSH environment
 */
export function remoteWrap(host, command) {
  const prefix = host.path_prefix || DEFAULT_PATH_PREFIX;
  return `export PATH=${prefix}:$PATH; ${command}`;
}

/**
 * Run a shell command on a host (local exec or remote via ssh).
 * Resolves {stdout, stderr}; throws on non-zero exit with err.code set,
 * matching promisified exec semantics.
 */
export async function execOnHost(host, command, opts = {}) {
  if (!isRemote(host)) {
    return execAsync(command, { timeout: 15000, ...opts });
  }
  return execFileAsync(
    'ssh',
    [...sshBaseArgs(host), host.ssh_target, remoteWrap(host, command)],
    { timeout: 15000, ...opts }
  );
}

/**
 * Did this fail because we couldn't reach the host at all (as opposed to the
 * remote command itself failing)? ssh exits 255 for every transport-level
 * failure — connect timeout, refused, DNS, auth, host key — and our own
 * execFile timeout shows up as a kill.
 */
export function isHostUnreachable(err) {
  if (!err) return false;
  if (err.code === 255) return true;
  if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return true;
  return /Connection timed out|Connection refused|Could not resolve hostname|No route to host|Host is down|Operation timed out|Network is unreachable|Connection closed by remote host/i.test(
    `${err.message || ''} ${err.stderr || ''}`
  );
}

/**
 * A message safe and useful to show a user for a failed host command.
 *
 * execFile stringifies the ENTIRE argv into err.message ("Command failed: ssh -o
 * BatchMode=yes … tmux set-buffer -b … -- 'how did things go?' …"), so returning
 * err.message raw dumped the whole internal ssh invocation — including the text
 * the user had just typed — into the UI, while never actually saying the host was
 * asleep. Report the condition instead, and never echo the command.
 */
export function describeHostError(err, host) {
  const name = (host && host.name) || 'the host';
  if (isHostUnreachable(err)) {
    return `Can't reach host ${name} — it looks offline or asleep. The agent's session is untouched and will still be there when the host is back.`;
  }
  const stderr = String((err && err.stderr) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (stderr.length) return `Host ${name}: ${stderr[stderr.length - 1]}`;
  return `Host ${name}: command failed`;
}

/**
 * Build the {file, args} pair for pty.spawn to attach to a tmux session
 */
export function attachSpawnArgs(host, sessionName) {
  // `=` forces an EXACT session match — tmux otherwise prefix-matches `-t`, so
  // attaching to `maestro` would land in `maestro_shell`. See tmux.js target().
  const exact = `=${sessionName}`;
  if (!isRemote(host)) {
    return { file: 'tmux', args: ['attach-session', '-t', exact] };
  }
  return {
    file: 'ssh',
    args: [
      ...sshBaseArgs(host),
      '-t',
      host.ssh_target,
      remoteWrap(host, `exec tmux attach-session -t ${shellQuote(exact)}`),
    ],
  };
}

/**
 * Test connectivity + tmux availability on a host; persists hosts.status
 */
export async function testHost(host) {
  try {
    const { stdout } = await execOnHost(host, 'tmux -V', { timeout: 10000 });
    updateHostStatus(host.id, 'online');
    return { ok: true, version: stdout.trim() };
  } catch (err) {
    updateHostStatus(host.id, 'offline');
    const raw = (err.stderr || err.message || 'Connection failed').toString().trim();
    return { ok: false, error: raw.split('\n')[0] };
  }
}
