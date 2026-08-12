import { getAgents, updateAgentStatus, updateAgentLastSeen, getHost, updateHostStatus } from './db.js';
import { getTmuxSessions } from './tmux.js';
import { getProvider } from './providers.js';
import { execOnHost, isRemote } from './hosts.js';

// Agent activity tracking
// Map of agentId -> { lastActivity: Date, state: 'busy'|'idle', sessionName: string, hostId: number|null, host: object|null, lastContent: string }
const agentActivity = new Map();
const stateListeners = new Set();

// How long without output before considering idle (in ms)
const IDLE_THRESHOLD = 5000; // 5 seconds

/**
 * Called when terminal output is received for a session
 * This is the key function - it gets called from the terminal service
 */
export function recordActivity(sessionName, hostId = null) {
  const normalizedHostId = hostId || null;
  // Find agent by session name + host (same-named sessions can exist on different hosts)
  for (const [agentId, info] of agentActivity) {
    if (info.sessionName === sessionName && (info.hostId || null) === normalizedHostId) {
      const wasIdle = info.state === 'idle';
      info.lastActivity = Date.now();

      if (wasIdle) {
        // Transition from idle to busy
        info.state = 'busy';
        emitStateChange(agentId, sessionName, 'busy', 'idle');
        updateAgentStatus(agentId, 'running');
      }
      return;
    }
  }
}

/**
 * Register an agent for monitoring
 * @param {object|null} host - Host row (null => local)
 */
export function registerAgent(agentId, sessionName, host = null) {
  if (!agentActivity.has(agentId)) {
    agentActivity.set(agentId, {
      sessionName,
      hostId: isRemote(host) ? host.id : null, // local hosts normalize to null
      host: host || null,
      lastActivity: Date.now(),
      state: 'busy', // Assume busy when first registered
      lastContent: '', // For pane content change detection
    });
  }
}

/**
 * Unregister an agent from monitoring
 */
export function unregisterAgent(agentId) {
  agentActivity.delete(agentId);
}

/**
 * Check all agents for idle timeout
 */
function checkIdleAgents() {
  const now = Date.now();

  for (const [agentId, info] of agentActivity) {
    if (info.state === 'busy') {
      const timeSinceActivity = now - info.lastActivity;

      if (timeSinceActivity >= IDLE_THRESHOLD) {
        // Transition from busy to idle
        info.state = 'idle';
        emitStateChange(agentId, info.sessionName, 'idle', 'busy');
        updateAgentStatus(agentId, 'idle');
      }
    }
  }
}

/**
 * Capture tmux pane content to detect activity
 */
async function capturePaneContent(sessionName, host = null) {
  try {
    const { stdout } = await execOnHost(
      host,
      `tmux capture-pane -t "${sessionName}" -p -S -20 2>/dev/null`
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Check tmux pane for changes (fallback when no terminal connected)
 */
async function checkPaneActivity(agentId, info) {
  const content = await capturePaneContent(info.sessionName, info.host);
  if (content === null) return;

  // Check if content changed
  if (content !== info.lastContent) {
    info.lastContent = content;
    info.lastActivity = Date.now();
    // Track most-recent agent output for dashboard sorting (bounded: at most one
    // write per agent per sync tick, only when the pane actually changed).
    updateAgentLastSeen(agentId);

    // If was idle, transition to busy
    if (info.state === 'idle') {
      info.state = 'busy';
      emitStateChange(agentId, info.sessionName, 'busy', 'idle');
      updateAgentStatus(agentId, 'running');
    }
  }
}

/**
 * Check if sessions still exist and sync state.
 *
 * Agents are grouped by host so each host's tmux server is probed exactly once
 * per tick (via getTmuxSessions) instead of once per agent. This means a down
 * remote host costs a single connect timeout rather than one per agent, and —
 * critically — an unreachable host (a sleeping Mac mini) leaves its agents'
 * state untouched instead of falsely flipping them all to 'stopped' (which they
 * could never recover from, since the re-register guard skips 'stopped' rows).
 */
let syncInProgress = false;

async function syncAgentStates() {
  if (syncInProgress) return; // prior tick still running (e.g. a slow/unreachable host)
  syncInProgress = true;
  try {
    const agents = getAgents();

    // Group agents by host (host_id 0/null => local)
    const groups = new Map();
    for (const agent of agents) {
      if (!agent.screen_session) continue;
      const hostKey = agent.host_id || 0;
      if (!groups.has(hostKey)) {
        const host = agent.host_id
          ? { id: agent.host_id, ssh_target: agent.host_ssh_target, path_prefix: agent.host_path_prefix }
          : null;
        groups.set(hostKey, { host, agents: [] });
      }
      groups.get(hostKey).agents.push(agent);
    }

    // Probe each host concurrently so a slow/unreachable host (a sleeping Mac
    // mini) never delays monitoring of agents on other hosts. Host groups touch
    // disjoint agents, and better-sqlite3 writes run synchronously on this
    // thread, so only the ssh awaits interleave — the DB writes stay serialized.
    await Promise.all([...groups.values()].map(({ host, agents: hostAgents }) =>
      syncHostGroup(host, hostAgents)
    ));
  } catch (err) {
    console.error('Error syncing agent states:', err);
  } finally {
    syncInProgress = false;
  }
}

// Publish a host's reachability from the monitor's own probe. Only remote hosts
// have a meaningful up/down, and only a CHANGE is written so the 2s tick doesn't
// hammer the DB with identical updates.
function noteHostReachable(host, reachable) {
  if (!host || !host.id || !isRemote(host)) return;
  const next = reachable ? 'online' : 'offline';
  try {
    const row = getHost(host.id);
    if (row && row.status !== next) {
      updateHostStatus(host.id, next);
      console.log(`Host ${row.name}: ${row.status} -> ${next}`);
    }
  } catch {
    /* status publishing must never break the monitor tick */
  }
}

// An unreachable host costs a full ssh ConnectTimeout (5s) on EVERY probe. With a
// 5s sync interval that is not a small tax — it means the sync never finishes
// before the next one is due, the reentrancy guard is permanently engaged, and
// every agent's state update on every OTHER host is delayed behind a host that has
// been dead for days (the Mac mini sat offline for six). So back off: after a
// failure, skip that host for a growing interval (10s, 20s, 40s … capped at 5min)
// instead of retrying every tick. Any success resets it immediately, so a host
// that wakes up is picked back up within one backoff window.
const HOST_BACKOFF_BASE_MS = 10_000;
const HOST_BACKOFF_MAX_MS = 300_000;
const hostBackoff = new Map(); // hostId -> { fails, nextAttempt }

function hostIsBackedOff(host) {
  if (!host || !host.id) return false;
  const b = hostBackoff.get(host.id);
  return !!(b && Date.now() < b.nextAttempt);
}

// Manual "Test host" is an explicit override: clear the backoff so a host the user
// just woke is picked up on the next sync rather than up to 5 minutes later.
export function resetHostBackoff(hostId) {
  if (hostId) hostBackoff.delete(Number(hostId));
}

function noteHostProbe(host, ok) {
  if (!host || !host.id) return;
  if (ok) {
    hostBackoff.delete(host.id);
    return;
  }
  const prev = hostBackoff.get(host.id);
  const fails = (prev ? prev.fails : 0) + 1;
  const wait = Math.min(HOST_BACKOFF_BASE_MS * 2 ** (fails - 1), HOST_BACKOFF_MAX_MS);
  hostBackoff.set(host.id, { fails, nextAttempt: Date.now() + wait });
  if (fails === 1 || wait === HOST_BACKOFF_MAX_MS) {
    console.log(`Host ${host.name || host.id} unreachable — backing off ${Math.round(wait / 1000)}s`);
  }
}

/**
 * Reconcile one host's agents against a single tmux probe of that host.
 */
async function syncHostGroup(host, hostAgents) {
  // Skip a host we already know is down until its backoff expires; its agents are
  // left exactly as they are, same as an in-tick failure would.
  if (hostIsBackedOff(host)) return;
  // One probe per host. getTmuxSessions returns [] for a reachable host with
  // no server (exit 1) but throws on transport failure — so a throw means
  // "unreachable", and we skip the host's agents rather than mark them stopped.
  let sessionNames;
  try {
    const sessions = await getTmuxSessions(host);
    sessionNames = new Set(sessions.map((s) => s.name));
    noteHostProbe(host, true);
    noteHostReachable(host, true);
  } catch {
    // Host unreachable — leave its agents' state untouched (a sleeping Mac mini
    // must not flip its still-running agents to stopped), but DO record that the
    // host is down. This probe already knows; without publishing it, hosts.status
    // only ever changed on a manual Test, so a mini that had been asleep for hours
    // still read "online" and the only symptom the user got was a raw ssh timeout.
    noteHostProbe(host, false);
    noteHostReachable(host, false);
    return;
  }

  for (const agent of hostAgents) {
    const provider = getProvider(agent.config?.provider);
    const exists = sessionNames.has(agent.screen_session);

    if (exists) {
      // Register for monitoring if not already (skip non-monitorable providers like shell)
      if (provider.monitorable && !agentActivity.has(agent.id) && agent.status !== 'stopped') {
        registerAgent(agent.id, agent.screen_session, host);
      }

      // Non-monitorable agents (shell) are up whenever their session exists, but we
      // can't tell whether they're working — there's no pane parsing behind them and
      // nothing ever transitions them out of 'running', so they'd pin the dashboard's
      // Active section indefinitely (maestro_shell sat there for 13 days). 'idle' is
      // the accurate state for up-but-not-observably-working. Written unconditionally
      // so rows left 'running' by an older build heal on the next tick.
      if (!provider.monitorable && agent.status !== 'idle') {
        updateAgentStatus(agent.id, 'idle');
      }

      // Check pane content for activity (fallback detection, monitorable agents only)
      const info = agentActivity.get(agent.id);
      if (info && provider.monitorable) {
        await checkPaneActivity(agent.id, info);
      }
    } else {
      // Session gone - mark as stopped
      if (agent.status !== 'stopped') {
        updateAgentStatus(agent.id, 'stopped');
        const info = agentActivity.get(agent.id);
        if (info) {
          emitStateChange(agent.id, agent.screen_session, 'stopped', info.state);
        }
        unregisterAgent(agent.id);
      }
    }
  }
}

/**
 * Emit state change to all listeners
 */
function emitStateChange(agentId, sessionName, newState, prevState) {
  const event = {
    type: 'agent_state_change',
    agentId,
    sessionName,
    state: newState,
    previousState: prevState,
    timestamp: new Date().toISOString(),
  };

  console.log(`Agent ${sessionName}: ${prevState} -> ${newState}`);

  for (const listener of stateListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('Error in state listener:', err);
    }
  }
}

/**
 * Register a listener for state changes
 */
export function onStateChange(callback) {
  stateListeners.add(callback);
  return () => stateListeners.delete(callback);
}

/**
 * Get current state for an agent
 */
export function getAgentState(agentId) {
  return agentActivity.get(agentId)?.state || 'unknown';
}

/**
 * Get all agent states
 */
export function getAllAgentStates() {
  const states = {};
  for (const [agentId, info] of agentActivity) {
    states[agentId] = info.state;
  }
  return states;
}

/**
 * Start monitoring
 */
let idleCheckInterval = null;
let syncInterval = null;

export function startMonitoring(checkIntervalMs = 1000, syncIntervalMs = 5000) {
  if (idleCheckInterval) return;

  console.log(`Starting agent monitoring (idle threshold: ${IDLE_THRESHOLD}ms)`);

  // Initial sync
  syncAgentStates();

  // Check for idle agents frequently
  idleCheckInterval = setInterval(checkIdleAgents, checkIntervalMs);

  // Sync with tmux sessions less frequently
  syncInterval = setInterval(syncAgentStates, syncIntervalMs);
}

export function stopMonitoring() {
  if (idleCheckInterval) {
    clearInterval(idleCheckInterval);
    idleCheckInterval = null;
  }
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  console.log('Stopped agent monitoring');
}
