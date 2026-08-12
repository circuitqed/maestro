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
