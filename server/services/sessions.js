import { isSessionNameTaken } from './db.js';

// Slugify an agent name into a valid tmux session name (matches the client's
// sanitizeSessionName in AddAgentForm.jsx): lowercase, non-[a-z0-9-] -> '-',
// collapse and trim dashes. May return '' for an all-symbol name.
export function sanitizeSessionName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Return a session name unique among agents on the given host (host_id null =
 * local). If `base` is free it is returned as-is; otherwise the first free
 * `base-2`, `base-3`, ... is chosen. This is what prevents a second agent whose
 * name slugs the same as an existing one from silently attaching to (hijacking)
 * the first agent's tmux session.
 */
export function uniqueSessionName(hostId, base, existingOnHost = null) {
  const root = base || 'agent';
  // `existingOnHost` are session names that live on the host but aren't Maestro
  // agents — the user's own sessions, or a set restored by tmux-continuum. Only a
  // DERIVED name avoids them: an explicitly chosen session name means "attach to
  // that one", which is a supported flow. Without this, a new agent whose slug
  // happens to match a stranger's session silently binds to it.
  const onHost = existingOnHost instanceof Set ? existingOnHost : new Set(existingOnHost || []);
  const taken = (n) => isSessionNameTaken(hostId, n) || onHost.has(n);
  if (!taken(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const cand = `${root}-${i}`;
    if (!taken(cand)) return cand;
  }
  return `${root}-${Date.now()}`;
}
