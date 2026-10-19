/**
 * Restart agents that are running an older build than the one on disk.
 *
 * Claude Code updates its own binary in the background and then tells the user
 * "Update installed - Restart to update": the RUNNING process keeps the old build
 * until someone restarts it. With releases landing most weeks, agents drift behind
 * silently -- em-sim-core was on 2.1.302 against 2.1.303 installed, and before the
 * garage reboot forced a restart there were sessions as far back as 2.1.296.
 *
 * Restarting is cheap here precisely because agentStart resumes: a Claude agent
 * comes back with `--resume <session-id>` and keeps its conversation, so the only
 * real cost is whatever is sitting unsent in the composer. That is why this is
 * worth automating at all -- it would not be if a restart meant losing context.
 *
 * Two signals, both needed:
 *   installed  `claude --version` on the agent's host (one call per host, cached).
 *   running    the newest `"version"` field in the agent's LIVE transcript. Taken
 *              from the transcript rather than /proc/<pid>/exe because the mac mini
 *              has no /proc, and rather than the pane's "Restart to update" banner
 *              because that wording is not an API.
 */
import { getSetting } from './db.js';
import { execOnHost, shellQuote } from './hosts.js';
import { resolveTranscriptFile } from './transcript.js';
import { isSettled, looksLikePrompt } from './inject.js';
import { capturePane, killSession } from './tmux.js';

const SCOPE = 'update'; // its own idle streak, independent of tasks/swarms

// Long on purpose. A new build is never urgent, and every restart costs the agent
// whatever it had typed but not sent.
const INTERVAL_MS = 15 * 60 * 1000;
const VERSION_TTL_MS = 10 * 60 * 1000;
const IDLE_TICKS = 3;          // ~45 min continuously idle at the interval above
// Restarting the whole fleet at once is its own outage. 30 agents were behind when
// this shipped (one by 80 versions); trickling them keeps any single bad build from
// taking everything down together, and keeps the dashboard legible while it happens.
const MAX_RESTARTS_PER_TICK = 3;

const installedCache = new Map(); // hostKey -> { at, version }
// When each agent was last bounced for an update.
//
// The version signal comes from the transcript's newest record, and a freshly
// restarted session has not written one yet -- so for the first turn or two it
// still reports the OLD version. Without this the next pass would see it as still
// behind and restart it again, forever, across every agent at once. Observed on
// Library: restarted onto 2.1.303, transcript still said 2.1.223.
const lastRestart = new Map();    // agentId -> timestamp
const RESTART_COOLDOWN_MS = 2 * 60 * 60 * 1000;
let timer = null;
let running = false;

const hostKey = (host) => (host ? host.id : 'local');

/** Semver-ish compare; returns true when `a` is strictly older than `b`. */
export function isOlder(a, b) {
  if (!a || !b || a === b) return false;
  const pa = String(a).split('.').map((n) => parseInt(n, 10));
  const pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** `claude --version` on this host, cached. Null when it cannot be determined. */
async function installedVersion(host) {
  const key = hostKey(host);
  const hit = installedCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.version;
  let version = null;
  try {
    const { stdout } = await execOnHost(host, 'claude --version 2>/dev/null', { timeout: 20000 });
    const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(String(stdout));
    version = m ? m[1] : null;
  } catch {
    version = null; // host down, or claude not on PATH for a non-interactive shell
  }
  installedCache.set(key, { at: Date.now(), version });
  return version;
}

/**
 * The build the agent's live session is actually running.
 *
 * Reads the tail rather than the whole file: these reach tens of MB and only the
 * last record matters. A session that has not written since an update still
 * reports the old version, which is correct -- it IS still running the old one.
 */
async function sessionVersion(agent, host) {
  let file;
  try {
    file = await resolveTranscriptFile(agent, host);
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    const { stdout } = await execOnHost(
      host,
      `tail -c 400000 ${shellQuote(file)} 2>/dev/null | grep -o '"version":"[0-9.]*"' | tail -1`,
      { timeout: 20000 }
    );
    const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(String(stdout));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Is it safe to bounce this agent right now?
 *
 * Same rule the task and swarm deliveries use: several consecutive idle readings,
 * and never while a pane is showing an interactive select. A restart during a trust
 * dialog would discard the question; a restart mid-turn would discard the turn.
 */
async function safeToRestart(agent, host) {
  if (agent.status !== 'idle') return false;
  if (!isSettled(agent.id, { scope: SCOPE, ticks: IDLE_TICKS })) return false;
  const pane = await capturePane(agent.screen_session, host).catch(() => '');
  return !looksLikePrompt(pane);
}

/**
 * One pass. Exported for tests and for an immediate run after a manual update.
 * `startAgentSession` is injected rather than imported to keep this module free of
 * the start path's dependency graph (and trivially stubbable).
 */
export async function checkOnce({ getAgents, getHost, startAgentSession, registerAgent, observeIdle }) {
  if (getSetting('auto_update_restart') === '0') return { checked: 0, restarted: 0 };
  if (observeIdle) observeIdle(SCOPE);
  let checked = 0;
  let restarted = 0;
  for (const agent of getAgents()) {
    if ((agent.config || {}).provider !== 'claude') continue;   // only claude reports a version this way
    if (!['idle', 'running', 'busy'].includes(agent.status)) continue;
    const host = agent.host_id ? getHost(agent.host_id) : null;
    const installed = await installedVersion(host);
    if (!installed) continue;
    const current = await sessionVersion(agent, host);
    if (!current || !isOlder(current, installed)) continue;
    checked += 1;
    const since = Date.now() - (lastRestart.get(agent.id) || 0);
    if (since < RESTART_COOLDOWN_MS) continue;          // just bounced; its transcript lags
    if (restarted >= MAX_RESTARTS_PER_TICK) continue;   // the rest wait for the next pass
    if (!(await safeToRestart(agent, host))) {
      console.log(`[update] ${agent.name} is on ${current}, ${installed} installed - busy, will retry`);
      continue;
    }
    try {
      // Kill first: startAgentSession adopts an existing session and would return
      // "Session already running" without ever launching the new binary.
      lastRestart.set(agent.id, Date.now());   // set BEFORE, so a throw cannot cause a retry storm
      await killSession(agent.screen_session, host);
      const out = await startAgentSession(agent, host, { registerAgent });
      restarted += 1;
      console.log(`[update] ${agent.name} restarted onto ${installed} (was ${current}): ${out.message}`);
    } catch (err) {
      console.log(`[update] ${agent.name} restart failed: ${err.message}`);
    }
  }
  return { checked, restarted };
}

export function startUpdateWatch(deps, intervalMs = INTERVAL_MS) {
  if (timer) clearInterval(timer);
  const tick = async () => {
    if (running) return;
    running = true;
    try { await checkOnce(deps); } catch (err) { console.error('[update] tick:', err.message); } finally { running = false; }
  };
  timer = setInterval(tick, intervalMs);
  return timer;
}

export function stopUpdateWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}
