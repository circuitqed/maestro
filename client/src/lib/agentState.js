/**
 * What an agent's row should actually say it is.
 *
 * `agent.status` is the last thing the monitor managed to OBSERVE, which is not the
 * same as what is true now. When a host stops answering, the monitor deliberately
 * leaves its agents' state alone -- a sleeping Mac mini must not flip its
 * still-running agents to `stopped` -- so the rows keep saying `idle` indefinitely.
 *
 * That default is right for the data and wrong for the display. After garage-wsl's
 * VM restarted, eight agents sat there reading a confident green `idle` while their
 * tmux sessions did not exist at all, and the only way to find out was to try to use
 * one. A stale green state is worse than no state, because it is indistinguishable
 * from a true one.
 *
 * So `unresponsive` is derived, never stored: the host says offline, therefore we
 * cannot see the agent, therefore we say so -- while still showing what it last was,
 * because "was running 3h ago" and "was stopped 3h ago" are different situations.
 */

/** Statuses that mean "there is a live session as far as we last knew". */
const LIVE = new Set(['running', 'busy', 'idle']);

/**
 * @param {object} agent  row from /api/agents (needs status, host_status, last_seen_at)
 * @returns {{state: string, stale: boolean, lastKnown: string|null, label: string}}
 *   `state` is what to render; `lastKnown` is the observed status it is standing in
 *   for, present only when stale.
 */
export function agentState(agent) {
  if (!agent) return { state: 'unknown', stale: false, lastKnown: null, label: 'unknown' };
  const status = agent.status || 'unknown';

  // host_status is absent for the local host (no hosts row) — local is always
  // reachable by definition, since the server is running on it.
  const hostDown = agent.host_status === 'offline';

  // A deliberately stopped agent is not "unresponsive": we are not failing to
  // observe it, it is simply off, and that stays true while the host is away.
  if (hostDown && LIVE.has(status)) {
    return { state: 'unresponsive', stale: true, lastKnown: status, label: 'unresponsive' };
  }
  return { state: status, stale: false, lastKnown: null, label: status };
}

/** True when this agent cannot currently be acted on, so UI can disable controls. */
export const isUnresponsive = (agent) => agentState(agent).state === 'unresponsive';

/** "3h 12m" from an ISO timestamp, for "last seen". */
export function sinceLabel(ts) {
  if (!ts) return null;
  const t = new Date(ts.endsWith && ts.endsWith('Z') ? ts : `${ts}Z`).getTime();
  if (Number.isNaN(t)) return null;
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 90) return 'just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, '0')}m ago` : `${Math.floor(h / 24)}d ago`;
}
