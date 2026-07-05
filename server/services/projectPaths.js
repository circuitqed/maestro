import fs from 'fs';
import { isRemote, execOnHost, shellQuote } from './hosts.js';
import { getProjectHostPath } from './db.js';

/**
 * Resolve the working directory for an agent given its (project, host).
 *
 * Single source of truth:
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
