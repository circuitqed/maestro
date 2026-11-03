import fs from 'fs';
import { isRemote, execOnHost, shellQuote } from './hosts.js';
import { getProjectHostPath } from './db.js';

/**
 * Resolve the working directory for a (project, host), ignoring any per-agent
 * override. This is the PROJECT's directory — prefer resolveAgentWorkingDir()
 * anywhere an agent is in hand.
 *
 *   - local host (host null / ssh_target NULL) => project.path
 *   - remote host => the project_host_paths row for (project.id, host.id),
 *     or null when none is configured yet.
 */
export function resolveWorkingDir(project, host) {
  if (!project) return null;
  if (!isRemote(host)) {
    return project.path || null;
  }
  const row = getProjectHostPath(project.id, host.id);
  return row && row.path ? row.path : null;
}

/**
 * Resolve the working directory for a specific AGENT.
 *
 * An agent may pin its own directory (agents.working_dir); otherwise it inherits
 * the project's path for that host. The override exists because
 * project_host_paths stores one path per (project, host): the add-agent form
 * asked for a working directory and then wrote it there, so creating one agent
 * with its own directory silently relocated every sibling on that host — seven
 * qubit_designer agents all ended up in one subdirectory after a restart.
 *
 * Absolute paths only (validated on the way in), so this never expands a tilde
 * or falls back to $HOME when spliced into `tmux -c`.
 */
export function resolveAgentWorkingDir(agent, project, host) {
  const own = agent && typeof agent.working_dir === 'string' ? agent.working_dir.trim() : '';
  if (own) return own;
  return resolveWorkingDir(project, host);
}

/**
 * The directory an agent ACTUALLY runs in, for routes that read or write files
 * next to it (chat attachments, the file viewer).
 *
 * resolveAgentWorkingDir() answers "what is configured", and null is a real
 * answer there: startAgentSession() then launches tmux without `-c`, so the agent
 * runs in the host's $HOME. Every host shell (no project by design) and any agent
 * on a project with an empty path is like this. Treating null as "nowhere" made
 * those agents refuse every upload with a bare red failure while the agent itself
 * was happily working in ~. So fall back to the same $HOME tmux used.
 */
export async function resolveAgentFileRoot(agent, project, host) {
  const configured = resolveAgentWorkingDir(agent, project, host);
  if (configured) return configured;
  if (!isRemote(host)) return process.env.HOME || null;
  const { stdout } = await execOnHost(host, 'printf %s "$HOME"');
  const home = String(stdout || '').trim();
  return home.startsWith('/') ? home : null;
}

/**
 * Ensure a directory exists on a host.
 *   - local  => fs.mkdirSync(path, { recursive: true })
 *   - remote => execOnHost(host, `mkdir -p <shellQuoted path>`)
 * Throws on failure (fs error locally, err.code / err.stderr remotely).
 */
export async function ensureDirOnHost(host, dirPath) {
  if (!isRemote(host)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  await execOnHost(host, `mkdir -p ${shellQuote(dirPath)}`);
}
