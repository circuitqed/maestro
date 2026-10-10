/**
 * How a swarm and its workers are allowed to look, in one place.
 *
 * Three components render worker state (the row's badge, the panel's NEEDS YOU band,
 * the panel's table) and the single most-reported defect in products like this is a
 * brake that reads as a hang: `over_budget` rendered as "failed" sends someone
 * hunting a bug in a worker that did exactly what it was told, and `admitted`
 * rendered as "running" sends them looking for a process that was never started.
 * So every state gets its own glyph, its own word, and its own colour, chosen once
 * here rather than three times in markup.
 */

export const WORKER_LOOK = {
  admitted: { icon: '◌', label: 'queued', text: 'text-gray-400', chip: 'bg-gray-600/30 text-gray-300',
    hint: 'admitted and holding a budget reservation, but nothing is running yet' },
  launching: { icon: '◍', label: 'starting', text: 'text-sky-300', chip: 'bg-sky-500/15 text-sky-300',
    hint: 'tmux session being created' },
  running: { icon: '●', label: 'running', text: 'text-blue-400', chip: 'bg-blue-500/15 text-blue-300',
    hint: 'working' },
  done: { icon: '✓', label: 'done', text: 'text-emerald-400', chip: 'bg-emerald-500/15 text-emerald-300',
    hint: 'reported a result' },
  failed: { icon: '✕', label: 'failed', text: 'text-red-400', chip: 'bg-red-500/15 text-red-300',
    hint: 'the worker exited non-zero or never reported' },
  timeout: { icon: '⏱', label: 'timed out', text: 'text-orange-400', chip: 'bg-orange-500/15 text-orange-300',
    hint: 'hit its wall-clock limit and was killed' },
  over_budget: { icon: '$', label: 'budget stop', text: 'text-amber-400', chip: 'bg-amber-500/15 text-amber-300',
    hint: 'stopped by its per-worker budget — a brake, not a crash' },
  cancelled: { icon: '⊘', label: 'cancelled', text: 'text-gray-500', chip: 'bg-gray-600/30 text-gray-400',
    hint: 'stopped because the swarm was halted or cancelled' },
};

const UNKNOWN_WORKER = { icon: '?', label: 'unknown', text: 'text-gray-400', chip: 'bg-gray-600/30 text-gray-300', hint: '' };

export const workerLook = (state) => WORKER_LOOK[state] || UNKNOWN_WORKER;

/**
 * Attention is NOT a state -- it is why this worker is in the NEEDS YOU band. Only
 * `stalled` has no corresponding state: a worker wedged before launch, or one past
 * its deadline that the runner has not reaped yet, still reads as alive everywhere
 * else. That is the window a human goes looking in.
 */
export const ATTENTION_LOOK = {
  stalled: { icon: '!', label: 'stalled', chip: 'bg-fuchsia-500/15 text-fuchsia-300',
    hint: 'past its deadline or never launched; the runner will reap it, you can look now' },
  failed: { ...WORKER_LOOK.failed, chip: 'bg-red-500/15 text-red-300' },
  timeout: { ...WORKER_LOOK.timeout },
  over_budget: { ...WORKER_LOOK.over_budget },
};

export const attentionLook = (attention) => ATTENTION_LOOK[attention] || null;

export const SWARM_LOOK = {
  pending_approval: { label: 'needs approval', dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-300' },
  running: { label: 'running', dot: 'bg-blue-500', chip: 'bg-blue-500/15 text-blue-300', pulse: true },
  halted: { label: 'halted', dot: 'bg-red-500', chip: 'bg-red-500/15 text-red-300' },
  cancelled: { label: 'cancelled', dot: 'bg-gray-500', chip: 'bg-gray-600/30 text-gray-400' },
  done: { label: 'done', dot: 'bg-emerald-500', chip: 'bg-emerald-500/15 text-emerald-300' },
};

const PAUSED_LOOK = { label: 'paused', dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-300' };

/** Paused is a flag on a running swarm, but to a reader it IS the state. */
export const swarmLook = (swarm) => {
  if (!swarm) return SWARM_LOOK.done;
  if (swarm.state === 'running' && swarm.paused) return PAUSED_LOOK;
  return SWARM_LOOK[swarm.state] || { label: swarm.state, dot: 'bg-gray-500', chip: 'bg-gray-600/30 text-gray-300' };
};

export const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/**
 * Seconds, as counted by the server.
 *
 * Deliberately takes a count and not a timestamp: swarm rows carry a mix of naive-UTC
 * SQLite strings and ISO strings, and `new Date('2026-07-24 10:00:00')` in a browser
 * reads the first as LOCAL time -- hours off for anyone west of UTC. The routes send
 * pre-computed ages precisely so no component is ever tempted to parse one.
 */
export const secs = (s) => {
  if (s === null || s === undefined) return '';
  const n = Math.abs(Math.round(s));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`;
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
};

export const ago = (s) => (s === null || s === undefined ? '' : s < 2 ? 'just now' : `${secs(s)} ago`);

/** A live worker's leash. Negative means the deadline has already gone past. */
export const remaining = (s) => {
  if (s === null || s === undefined) return '';
  return s < 0 ? `${secs(s)} past deadline` : `${secs(s)} left`;
};
