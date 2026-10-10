/**
 * Launching one admitted worker: the only place a swarm turns into a process.
 *
 * Everything expensive has already been decided by the time we get here --
 * swarm.js's admission gate is what says a worker may exist at all, and it has
 * already written the row, the deadline and the report token. This file's whole job
 * is to start `maestro-worker` in a tmux session without breaking any of the
 * assumptions the rest of the system makes about it.
 *
 * Three of those assumptions drive every decision below:
 *
 *   1. The PROMPT NEVER GOES IN ARGV. It is tens of kB of text another agent wrote,
 *      it would be world-readable in `ps` for the life of the worker, and argv has a
 *      length limit that a 20-item batch can reach. It arrives on stdin, from a file
 *      that is unlinked the instant the worker holds its descriptor.
 *   2. THE SESSION DIES WITH THE WORKER. A session that is gone is how the runner
 *      detects a worker that died without reporting; tmux.js createSession() appends
 *      `; exec bash` so an AGENT's session survives its provider, which would leave
 *      every worker as an immortal shell and make that signal useless. So the
 *      new-session line is built here rather than reused from there.
 *   3. A WORKER IS NOT AN AGENT. It gets no row in `agents` and -- deliberately --
 *      no MAESTRO_SESSION in its environment, so the maestro-task CLI cannot work
 *      from inside it. It can report its own result and nothing else.
 *
 * v1 is local-host only. The local path works because the container shares /tmp and
 * the tmux socket with oracle, so a file this process writes is the same file the
 * pane reads. A remote host needs the prompt shipped over ssh stdin instead, and is
 * refused outright rather than half-supported.
 */
import fs from 'fs';
import path from 'path';

import { getAgent, getHost, getProject, getSetting } from './db.js';
import { execOnHost, isRemote, isValidSessionName, shellQuote as q, execOnHostWithInput } from './hosts.js';
import { killSession, sessionExists } from './tmux.js';
import { resolveAgentWorkingDir } from './projectPaths.js';
import { logSwarmEvent, setWorkerStateIfLive } from './swarm.js';

// Where the prompt goes on its way in, and where the worker's diagnostics land.
// /tmp because it is shared between this container and the host that runs the pane,
// and because none of it is meant to outlive a reboot.
const RUN_ROOT = '/tmp/maestro-swarms';

// The repo copy is the real one on oracle (/home/projects is bind-mounted into the
// container at the same path, so this resolves identically on both sides).
const WORKER_BIN_DEFAULT = '/home/projects/maestro/scripts/maestro-worker';

// The worker must reach the server over HTTP to report. It runs on the HOST, so
// container-internal addresses are wrong: 7007 is the published port, matching the
// MAESTRO_URL that scripts/install-agent-cli.sh writes for agents.
const MAESTRO_URL_DEFAULT = 'http://127.0.0.1:7007';
// oracle's tailnet address: reachable from every host in the fleet.
const MAESTRO_REMOTE_URL_DEFAULT = 'http://100.72.255.33:7007';

// v1 workers analyse, they do not edit. maestro-worker turns this into an explicit
// deny-list over the write tools; it is not configurable per swarm on purpose --
// "which tools may a budget-capped process the lead wrote the prompt for use?" is a
// decision for a human changing this line, not for a request body.
const PROFILE = 'read-only';

// Headless runs draw no TUI, but capture-pane is still the first thing anyone
// reaches for when a launch misbehaves, and a narrow window wraps the JSON report
// into soup.
const TMUX_COLS = 200;
const TMUX_ROWS = 50;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Settings win over the environment: an admin can repoint these without a redeploy. */
export const workerBin = () =>
  getSetting('swarm_worker_bin') || process.env.MAESTRO_WORKER_BIN || WORKER_BIN_DEFAULT;

/**
 * Where a worker should POST its report.
 *
 * Host-dependent: a worker on garage-wsl reporting to 127.0.0.1 would hit its own
 * loopback, so a remote worker needs an address that is routable FROM the worker
 * (the tailnet one). Getting this wrong does not fail loudly -- the worker just
 * retries for five minutes and the result only survives in its --out file.
 */
export const maestroUrl = (host = null) =>
  (isRemote(host)
    ? getSetting('maestro_remote_url') || process.env.MAESTRO_REMOTE_URL || MAESTRO_REMOTE_URL_DEFAULT
    : getSetting('maestro_url') || process.env.MAESTRO_URL || MAESTRO_URL_DEFAULT);

/**
 * `swarm-<first 8 of the swarm id>-<idx>`. Charset-validated by the caller before it
 * ever reaches tmux; a uuid's first 8 characters are hex, so this is always valid,
 * and the id prefix is what keeps two concurrent swarms from colliding on idx.
 */
export function sessionNameFor(swarmId, idx) {
  const key = String(swarmId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'nosid';
  return `swarm-${key}-${idx}`;
}

const runDir = (swarmId) =>
  path.join(RUN_ROOT, String(swarmId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'nosid');

// Dollars as a CLI argument: trimmed to 4dp so a float artefact
// (0.6000000000000001) never reaches --max-budget-usd.
const usd = (n) => String(+Number(n || 0).toFixed(4));

/**
 * Where the worker runs. It inherits the spawning agent's directory, because the
 * items it was given are about that agent's project and a worker started in $HOME
 * cannot read any of the paths they mention. Omitted when it does not resolve:
 * tmux silently falls back to $HOME for a missing `-c`, which is a worse answer than
 * no answer but not worth failing a launch over.
 */
function workerCwd(swarm, host) {
  const agent = getAgent(swarm.spawner_agent_id);
  if (!agent) return null;
  const project = agent.project_id ? getProject(agent.project_id) : null;
  const dir = resolveAgentWorkingDir(agent, project, host);
  if (!dir || !dir.startsWith('/')) return null;
  if (!isRemote(host) && !fs.existsSync(dir)) return null;
  return dir;
}

/**
 * Start `worker` in its own tmux session.
 *
 * @param {object} swarm  the swarm row (budget, timeout, account, model, host)
 * @param {object} worker the row admitWorker() returned (id, idx, prompt, report_token)
 * @returns {Promise<string>} the session name it is running in
 */
export async function launchWorker(swarm, worker) {
  const host = swarm.host_id ? getHost(swarm.host_id) : null;

  const session = worker.session_name || sessionNameFor(swarm.id, worker.idx);
  if (!isValidSessionName(session)) {
    throw fail('BAD_SESSION', `refusing to launch into session name ${session}`);
  }
  const prompt = String(worker.prompt || '');
  if (!prompt.trim()) throw fail('EMPTY_PROMPT', 'worker has no prompt to run');
  if (!worker.report_token) throw fail('NO_TOKEN', 'worker has no report token');

  // 0700 on the directory, not just 0600 on the prompt: the report written beside it
  // holds the worker's answer, and /tmp is shared with every process on the box.
  const dir = runDir(swarm.id);
  const promptFile = path.join(dir, `${worker.idx}.prompt`);
  const logFile = path.join(dir, `${worker.idx}.log`);
  const outFile = path.join(dir, `${worker.idx}.json`);
  // Written ON the host that will read it, over stdin. Locally this is the same
  // file either way; remotely the container's /tmp is not the worker's /tmp, and
  // putting the prompt in argv (the obvious alternative) is exactly what fd 3
  // exists to avoid -- it is large and it is attacker-influenceable.
  await execOnHostWithInput(
    host,
    `mkdir -p ${q(dir)} && chmod 700 ${q(dir)} && umask 077 && cat > ${q(promptFile)}`,
    prompt
  );

  try {
    // 'launching' before anything is started, with the session name recorded: if
    // Maestro dies here, the runner finds a live row whose session never existed and
    // closes it out instead of leaving a budget reservation standing forever.
    setWorkerStateIfLive(worker.id, 'launching', { session_name: session });

    // A session under this name can only be a husk from a previous incarnation --
    // the name is swarm- plus a uuid prefix, so it is never a human's. Left alone it
    // would make new-session fail and strand the worker.
    if (await sessionExists(session, host)) {
      await killSession(session, host);
      logSwarmEvent(swarm.id, 'stale_session', `killed a leftover ${session} before launching`, worker.id);
    }

    const args = [
      q(workerBin()),
      '--id', q(worker.id),
      '--budget', q(usd(swarm.per_worker_usd)),
      '--timeout', q(String(swarm.per_worker_seconds)),
      '--account', q(swarm.account_dir),
      '--report-url', q(maestroUrl(host)),
      '--profile', q(PROFILE),
      // A second copy of the report, on disk, for the case the POST never lands.
      '--out', q(outFile),
    ];
    if (swarm.model) args.push('--model', q(swarm.model));

    const inner = [
      // The prompt on fd 3, then unlinked: an open descriptor outlives the directory
      // entry, so the text is never in argv, never in `ps`, and not on disk after
      // this line -- even if the pane is killed mid-run.
      `exec 3< ${q(promptFile)}`,
      `rm -f ${q(promptFile)}`,
      // exec, so the pane's process IS the worker: the session ends exactly when it
      // does, and killing the session actually kills it (verified -- with the worker
      // as a CHILD of the pane's shell, `tmux kill-session` left the process running
      // and billing).
      //
      // stderr goes to a file and stdout deliberately does NOT. Redirecting both
      // away closes the last descriptor on the pane's pty, and tmux then reaps the
      // pane the instant it starts: the session disappeared while the worker ran on,
      // which makes the runner's "session gone => worker gone" rule declare every
      // live worker vanished within seconds. One fd stays on the pty; the report is
      // on stdout, so it is also what `capture-pane` shows while the worker is up.
      `exec env MAESTRO_URL=${q(maestroUrl(host))} ${args.join(' ')} <&3 2>>${q(logFile)}`,
    ].join('; ');

    // The report token rides the SESSION environment, not argv: argv is readable
    // from /proc by any local process for the worker's whole life, and that token
    // can close the worker out -- freeing its slot and its reservation while the
    // real process carries on billing. The prompt is already kept out of argv via
    // fd 3 for the same reason; this closes the other half.
    let cmd = `tmux new-session -d -x ${TMUX_COLS} -y ${TMUX_ROWS} -s ${q(session)}`;
    cmd += ` -e MAESTRO_REPORT_TOKEN=${q(worker.report_token)}`;
    const cwd = workerCwd(swarm, host);
    if (cwd) cmd += ` -c ${q(cwd)}`;
    cmd += ` ${q(inner)}`;

    await execOnHost(host, cmd);
    setWorkerStateIfLive(worker.id, 'running');
    logSwarmEvent(swarm.id, 'launched', `${session} · $${usd(swarm.per_worker_usd)} · ${swarm.per_worker_seconds}s · log ${logFile}`, worker.id);
    return session;
  } catch (err) {
    // The unlink normally happens inside the pane; if we never got that far the
    // prompt is still sitting there.
    // The inner script rm's it the moment fd 3 is open, so this is only a
    // belt-and-braces sweep for a launch that failed before that ran.
    try {
      if (isRemote(host)) await execOnHost(host, `rm -f ${q(promptFile)}`);
      else fs.unlinkSync(promptFile);
    } catch { /* already gone */ }
    throw err;
  }
}
