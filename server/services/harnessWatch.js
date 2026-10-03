/**
 * Keep agents on the CLI version that is actually installed.
 *
 * Claude Code self-updates its install, but a RUNNING agent keeps the version it
 * started with — fleet-wide that drifts badly (agents were found running 2.1.219
 * against 2.1.283 installed, four months of fixes behind). Codex does not even
 * self-update; scripts/cli-watch.sh handles installing that, and this picks up the
 * reload afterwards.
 *
 * Restarting is safe for both providers now: Claude resumes its transcript and Codex
 * resumes its rollout, so a reload continues the conversation rather than replacing it.
 * What makes this safe to run unattended is WHEN it acts:
 *
 *   - only agents whose running binary differs from the installed one
 *   - only while they are idle, never mid-turn
 *   - only inside a quiet window (default 04:00–06:00 local), so a reload never
 *     lands in the middle of someone's working session
 *
 * Anything busy is simply left for the next night.
 */
import { getAgents, getHost } from './db.js';
import { execOnHost, isRemote } from './hosts.js';
import { startAgentSession } from './agentStart.js';
import { killSession } from './tmux.js';

const QUIET_START_HOUR = 4;
const QUIET_END_HOUR = 6;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // half-hourly; the window check does the gating

let timer = null;
let lastRunDay = null;

function inQuietWindow(now = new Date()) {
  const h = now.getHours();
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

/** Version string of the binary a session's provider process is actually running. */
async function runningVersion(host, sessionName) {
  const script =
    `pane=$(tmux list-panes -t '=${sessionName}:' -F '#{pane_pid}' 2>/dev/null | head -1); ` +
    `[ -z "$pane" ] && exit 0; ` +
    `for pid in $(pgrep -P "$pane" 2>/dev/null); do ` +
    `  exe=$(readlink /proc/$pid/exe 2>/dev/null); ` +
    `  case "$exe" in *claude*|*codex*) echo "$exe"; break;; esac; ` +
    `done`;
  try {
    const { stdout } = await execOnHost(host, script);
    const m = String(stdout).match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null; // host asleep or no /proc (macOS) — just skip this one
  }
}

/** Version string of the binary that WOULD be launched now. */
async function installedVersion(host, provider) {
  try {
    const { stdout } = await execOnHost(host, `${provider} --version 2>/dev/null | head -1`);
    const m = String(stdout).match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

async function reloadStaleAgents({ registerAgent } = {}) {
  const byHost = new Map();
  for (const agent of getAgents()) {
    const provider = (agent.config && agent.config.provider) || 'claude';
    if (provider !== 'claude' && provider !== 'codex') continue; // shell has no version
    if (agent.status !== 'idle') continue;                       // never interrupt work
    const key = agent.host_id || 0;
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key).push({ agent, provider });
  }

  for (const [hostId, entries] of byHost) {
    const host = hostId ? getHost(hostId) : null;
    if (hostId && !host) continue;
    // macOS has no /proc, so the running version can't be read there; skip rather than
    // restart blindly, which would interrupt a session for no established reason.
    if (host && /darwin|mac/i.test(host.name || '')) continue;

    const installed = {};
    for (const { provider } of entries) {
      if (!(provider in installed)) installed[provider] = await installedVersion(host, provider);
    }

    for (const { agent, provider } of entries) {
      const want = installed[provider];
      if (!want) continue;
      const have = await runningVersion(host, agent.screen_session);
      if (!have || have === want) continue;

      try {
        // Kill first: startProviderSession would otherwise adopt the live session and
        // leave the old binary running, which is exactly what we are trying to replace.
        await killSession(agent.screen_session, host);
        const out = await startAgentSession(agent, host, { registerAgent });
        console.log(`Harness reload: ${agent.name} ${provider} ${have} -> ${want} (${out.message})`);
      } catch (err) {
        console.log(`Harness reload failed for ${agent.name}: ${err.message}`);
      }
    }
  }
}

export function startHarnessWatch(deps = {}) {
  if (timer) return;
  const tick = async () => {
    try {
      const now = new Date();
      const day = now.toDateString();
      if (!inQuietWindow(now) || lastRunDay === day) return;
      lastRunDay = day;
      console.log('Harness reload: checking for agents on a stale CLI');
      await reloadStaleAgents(deps);
    } catch (err) {
      console.log(`Harness watch error: ${err.message}`);
    }
  };
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  tick();
}

export function stopHarnessWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Exported for a manual run (and so the behaviour is testable without waiting for 4am).
export { reloadStaleAgents, inQuietWindow };
