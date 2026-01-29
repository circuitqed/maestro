import { exec } from 'child_process';
import { promisify } from 'util';
import { getAgents, updateAgentStatus } from './db.js';
import { sessionExists } from './tmux.js';

const execAsync = promisify(exec);

// Agent activity tracking
// Map of agentId -> { lastActivity: Date, state: 'busy'|'idle', sessionName: string, lastContent: string }
const agentActivity = new Map();
const stateListeners = new Set();

// How long without output before considering idle (in ms)
const IDLE_THRESHOLD = 5000; // 5 seconds

/**
 * Called when terminal output is received for a session
 * This is the key function - it gets called from the terminal service
 */
export function recordActivity(sessionName) {
  // Find agent by session name
  for (const [agentId, info] of agentActivity) {
    if (info.sessionName === sessionName) {
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
 */
export function registerAgent(agentId, sessionName) {
  if (!agentActivity.has(agentId)) {
    agentActivity.set(agentId, {
      sessionName,
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
async function capturePaneContent(sessionName) {
  try {
    const { stdout } = await execAsync(
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
  const content = await capturePaneContent(info.sessionName);
  if (content === null) return;

  // Check if content changed
  if (content !== info.lastContent) {
    info.lastContent = content;
    info.lastActivity = Date.now();

    // If was idle, transition to busy
    if (info.state === 'idle') {
      info.state = 'busy';
      emitStateChange(agentId, info.sessionName, 'busy', 'idle');
      updateAgentStatus(agentId, 'running');
    }
  }
}

/**
 * Check if sessions still exist and sync state
 */
async function syncAgentStates() {
  try {
    const agents = getAgents();

    for (const agent of agents) {
      if (!agent.screen_session) continue;

      const exists = await sessionExists(agent.screen_session);

      if (exists) {
        // Register for monitoring if not already
        if (!agentActivity.has(agent.id) && agent.status !== 'stopped') {
          registerAgent(agent.id, agent.screen_session);
        }

        // Check pane content for activity (fallback detection)
        const info = agentActivity.get(agent.id);
        if (info) {
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
  } catch (err) {
    console.error('Error syncing agent states:', err);
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
