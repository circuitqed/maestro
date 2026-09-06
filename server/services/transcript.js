import { spawn } from 'child_process';
import { URL } from 'url';
import {
  execOnHost,
  shellQuote,
  isRemote,
  sshBaseArgs,
  remoteWrap,
  isValidSessionName,
} from './hosts.js';
import {
  getAgent,
  getHost,
  getProject,
  getPinnedSessionIdsOnHost,
  setAgentClaudeSessionId,
} from './db.js';
import { resolveAgentWorkingDir } from './projectPaths.js';

// A single transcript line can legitimately be large (base64 images embedded in
// tool_result records), so the cap is generous. It only exists to bound memory
// against a pathological never-terminated line, not to clip real records.
const MAX_LINE_BYTES = 16 * 1024 * 1024;

// Chat opens on the most recent slice of the transcript, then follows live. A long
// session (tens of thousands of lines) otherwise streams and renders in full before
// it can settle at the bottom — the dominant cost for big sessions. The tmux
// terminal and the raw .jsonl still hold the complete history.
const INITIAL_TAIL_LINES = 500;

/**
 * Validate a Claude session id before splicing it into a shell command.
 * (hex digits + dashes, length 36 — matches a UUID's shape)
 */
export function isUuid(s) {
  return /^[0-9a-fA-F-]{36}$/.test(s || '');
}

/**
 * Encode a working directory the way Claude Code names its per-project
 * transcript folder: every non-alphanumeric char becomes a dash.
 * The result is strictly [A-Za-z0-9-], i.e. shell-safe by construction.
 */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Locate the JSONL transcript file for an agent, on its host (local or remote).
 * Returns an absolute path string (valid on `host`) or null.
 *
 * Strategy:
 *   1. If the agent has a pinned claude_session_id, find <id>.jsonl under
 *      ~/.claude/projects/ * / (the filename equals the session id).
 *   2. Otherwise (or if that file is gone), fall back to the newest-mtime
 *      *.jsonl inside the project's encoded-cwd folder.
 *
 * @param {object} agent - Agent row (needs claude_session_id, project_id)
 * @param {object|null} host - Host row (null => local)
 */
export async function findPinnedTranscript(host, sessionId) {
  if (!isUuid(sessionId)) return null;
  try {
    // "$HOME" is double-quoted so it expands; the -name arg is shell-quoted.
    const { stdout } = await execOnHost(
      host,
      `find "$HOME/.claude/projects" -maxdepth 2 -name ${shellQuote(
        `${sessionId}.jsonl`
      )} 2>/dev/null | head -1`
    );
    return firstLine(stdout);
  } catch {
    return null;
  }
}

/**
 * Does the transcript file for a pinned session id already exist on `host`?
 * Used at agent-start to choose --session-id (create) vs --resume (continue):
 * Claude rejects --session-id when the file exists AND rejects --resume when it
 * doesn't, so the decision must be driven by the file's actual presence.
 */
export async function pinnedTranscriptExists(host, sessionId) {
  return !!(await findPinnedTranscript(host, sessionId));
}

// The trailing UUID of a Codex rollout filename
// (rollout-<ISO ts>-<uuid>.jsonl); null if the name doesn't match.
function rolloutIdFromPath(p) {
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(p || '');
  return m ? m[1] : null;
}

/**
 * Resolve a Codex agent's rollout from the RUNNING session rather than from
 * bookkeeping done at start time.
 *
 * Why: Codex creates its rollout file lazily — on the first user message, not at
 * launch — so a snapshot-diff taken during `start` almost always finds nothing and
 * the agent keeps the pin from its PREVIOUS run. The chat then tails a dead session
 * while tmux shows the live one (and after a working-dir change the two aren't even
 * the same conversation). Asking the live process removes that whole class of drift.
 *
 * Order, most authoritative first:
 *  1. the rollout the agent's own pane process currently holds open (`/proc/<pid>/fd`
 *     on Linux, `lsof` on macOS) — exact, and correct even when several agents share
 *     one working directory;
 *  2. the pinned id, but only if that file was written during the CURRENT tmux
 *     session — an older mtime means it belongs to a previous run;
 *  3. the newest rollout whose recorded cwd matches, skipping ids pinned by sibling
 *     agents so a shared working dir can't hand back someone else's conversation.
 *
 * Codex holds the rollout open on Linux but not on macOS, so (1) is best-effort and
 * the later steps still carry macOS hosts. Returns an absolute host path, or null.
 */
export async function resolveCodexRollout(host, sessionName, cwd, pinnedId, excludeIds = []) {
  if (!sessionName || !isValidSessionName(sessionName)) return null;
  const pin = isUuid(pinnedId) ? pinnedId : '';
  // A single alternation, built here rather than looped over in the shell (below).
  // UUIDs are hex+dashes only, so they need no regex escaping.
  const exclude = (excludeIds || []).filter((id) => isUuid(id) && id !== pin).join('|');
  const S = shellQuote(sessionName);
  const C = shellQuote(cwd || '');
  const P = shellQuote(pin);
  const X = shellQuote(exclude);

  // `created` is the current tmux session's start time; a rollout last written before
  // it cannot belong to this run. list-sessions (not display-message, which needs a
  // client and prints nothing over ssh) is what actually reports it.
  const script = [
    `S=${S}; C=${C}; P=${P}; X=${X}`,
    `created=$(tmux list-sessions -f "#{==:#{session_name},$S}" -F '#{session_created}' 2>/dev/null | head -1)`,
    `[ -n "$created" ] || created=0`,
    `m(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }`,
    // A codex process can hold SEVERAL rollouts open at once — an aborted turn
    // spawns a fresh one while the conversation keeps being written to the
    // original. Taking the first fd found picked the newer-CREATED file, which was
    // already dead, so the chat tailed a transcript frozen at the abort while the
    // agent went on replying. Collect every open rollout and take the most recently
    // WRITTEN one. printf | while-read, not `for f in $list`, because ssh runs the
    // host's login shell and zsh does not word-split unquoted expansions.
    // Find the pane's processes by PANE_PID, not by tty. `ps -t <tty>` resolves the
    // tty against the CALLER's /dev/pts, and Maestro runs in a container with its
    // own devpts — so for a LOCAL agent the tty never matched and this whole step
    // silently found nothing (it only ever worked over ssh, where the command runs
    // on the real host). pane_pid plus two generations of children covers
    // `bash -lc` -> codex -> helpers.
    `pane=$(tmux list-panes -t "=$S:" -F '#{pane_pid}' 2>/dev/null | head -1)`,
    `if [ -n "$pane" ]; then`,
    `  kids=$(pgrep -P "$pane" 2>/dev/null)`,
    `  gkids=$(printf '%s\\n' "$kids" | grep -v '^$' | while read -r k; do pgrep -P "$k" 2>/dev/null; done)`,
    `  pids=$(printf '%s\\n%s\\n%s' "$pane" "$kids" "$gkids" | grep -v '^$' | sort -u)`,
    `  cands=$(printf '%s\\n' "$pids" | while read -r p; do`,
    `      ls -l "/proc/$p/fd" 2>/dev/null | sed -n 's|.* -> \\(/.*\\.codex/sessions/.*\\.jsonl\\)$|\\1|p'`,
    `      lsof -p "$p" -Fn 2>/dev/null | sed -n 's|^n\\(/.*\\.codex/sessions/.*\\.jsonl\\)$|\\1|p'`,
    `    done)`,
    // A codex process can hold SEVERAL rollouts open at once (an aborted turn spawns
    // a fresh one while the conversation keeps being written to the original), so
    // take the most recently WRITTEN, never simply the first found.
    `  f=$(printf '%s\\n' "$cands" | grep -v '^$' | sort -u | while read -r c; do`,
    `        printf '%s\\t%s\\n' "$(m "$c")" "$c"; done | sort -rn | head -1 | cut -f2)`,
    `  [ -n "$f" ] && { echo "$f"; exit 0; }`,
    `fi`,
    `if [ -n "$P" ]; then f=$(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*-"$P".jsonl 2>/dev/null | head -1)`,
    `  if [ -n "$f" ] && [ "$(m "$f")" -ge "$created" ]; then echo "$f"; exit 0; fi; fi`,
    `[ -n "$C" ] || exit 0`,
    // Sibling ids are dropped with ONE grep -Ev over an alternation, not a
    // `for x in $X` loop: ssh runs the host's login shell, and zsh (the macOS
    // default) does not word-split an unquoted expansion — the loop would have
    // tested the whole list as a single token and excluded nothing.
    `best=$(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -50 \\`,
    `  | { if [ -n "$X" ]; then grep -Ev "$X"; else cat; fi; } \\`,
    `  | while read -r f; do`,
    `  head -1 "$f" | grep -qF "\\"cwd\\":\\"$C\\"" && { echo "$f"; break; }`,
    `done)`,
    `[ -n "$best" ] && [ "$(m "$best")" -ge "$created" ] && echo "$best"`,
  ].join('\n');

  try {
    const { stdout } = await execOnHost(host, script);
    return firstLine(stdout) || null;
  } catch {
    return null;
  }
}

export async function resolveTranscriptFile(agent, host) {
  // Codex keeps its own transcript format/location — resolve by matching the
  // rollout's recorded cwd to this agent's (host-aware) working directory. A pinned
  // session id (captured at start) takes precedence so that multiple Codex agents
  // sharing one working dir each resolve to their own rollout instead of collapsing
  // onto the single newest one.
  if (agent && agent.config && agent.config.provider === 'codex') {
    const project = agent.project_id ? getProject(agent.project_id) : null;
    const cwd = resolveAgentWorkingDir(agent, project, host);
    const siblings = getPinnedSessionIdsOnHost(agent.id, agent.host_id);
    const file = await resolveCodexRollout(
      host,
      agent.screen_session,
      cwd,
      agent.claude_session_id,
      siblings
    );
    if (!file) return null;
    // Keep the pin in step with what the live session actually resolved to, so the
    // transcript stays readable once the process is gone (stopped agent, dead pane).
    const id = rolloutIdFromPath(file);
    if (id && id !== agent.claude_session_id) {
      try {
        setAgentClaudeSessionId(agent.id, id);
      } catch {
        /* pin refresh is an optimisation, never a reason to fail resolution */
      }
    }
    return file;
  }

  // 1. Pinned session id: the transcript filename equals the session id.
  if (agent && agent.claude_session_id && isUuid(agent.claude_session_id)) {
    const pinned = await findPinnedTranscript(host, agent.claude_session_id);
    if (pinned) return pinned;
  }

  // 2. Fallback: newest *.jsonl in the project's encoded-cwd folder.
  if (agent) {
    const project = agent.project_id ? getProject(agent.project_id) : null;
    // The agent's OWN directory, not project.path: Claude encodes the cwd it was
    // launched in, which differs per agent once a working_dir override is set
    // (and, for a remote agent, was never project.path to begin with).
    const cwd = resolveAgentWorkingDir(agent, project, host);
    if (cwd) {
      const enc = encodeCwd(cwd);
      // enc is [A-Za-z0-9-] only, so it is safe to splice unquoted. "$HOME" is
      // double-quoted so it expands; the /*.jsonl glob stays OUTSIDE the quotes
      // so the shell (local sh or remote login shell) expands it.
      if (enc && /^[A-Za-z0-9-]+$/.test(enc)) {
        try {
          const { stdout } = await execOnHost(
            host,
            `ls -t "$HOME/.claude/projects/${enc}"/*.jsonl 2>/dev/null | head -1`
          );
          const line = firstLine(stdout);
          if (line) return line;
        } catch {
          /* nothing found */
        }
      }
    }
  }

  return null;
}

function firstLine(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || null;
}

/**
 * Build the {file, args} pair for spawning a follow-tail of the transcript.
 * Mirrors hosts.attachSpawnArgs: local runs tail directly, remote runs it over
 * ssh (no pty — this is a plain stream). `-n +1` replays existing history then
 * `-F` follows the growing file across renames/rotations.
 *
 * @param {object|null} host - Host row (null => local)
 * @param {string} filePath - Absolute path (valid on `host`)
 */
export function tailSpawnArgs(host, filePath) {
  if (!isRemote(host)) {
    return { file: 'tail', args: ['-n', String(INITIAL_TAIL_LINES), '-F', filePath] };
  }
  return {
    file: 'ssh',
    args: [
      ...sshBaseArgs(host),
      '-o',
      'ServerAliveInterval=15',
      host.ssh_target,
      // NOT `exec tail`: killing the local ssh leaves the remote tail running, because
      // `tail -F` on a quiet transcript never writes and so never sees the closed pipe.
      // (27 of these had accumulated on the Mac mini, the oldest 9 days old.) Instead
      // run tail in the background and heartbeat a blank line — the parser skips empty
      // lines — so a dead channel surfaces as a failed write within 20s and the trap
      // takes the tail down with the shell. Self-healing even if Maestro itself dies.
      remoteWrap(
        host,
        `tail -n ${INITIAL_TAIL_LINES} -F ${shellQuote(filePath)} & tp=$!; ` +
          `trap 'kill $tp 2>/dev/null' EXIT HUP INT TERM PIPE; ` +
          `while kill -0 $tp 2>/dev/null; do printf '\\n' || exit 0; sleep 20; done`
      ),
    ],
  };
}

// tail -n <k> without -F: a one-shot read of the last k lines (for load-earlier).
function tailReadArgs(host, filePath, k) {
  if (!isRemote(host)) {
    return { file: 'tail', args: ['-n', String(k), filePath] };
  }
  return {
    file: 'ssh',
    args: [
      ...sshBaseArgs(host),
      host.ssh_target,
      remoteWrap(host, `exec tail -n ${k} ${shellQuote(filePath)}`),
    ],
  };
}

/**
 * One-shot read of the last `k` lines of an agent's transcript, parsed to records.
 * Backs the chat's "load earlier messages" control. spawn (not exec) so a big slice
 * with embedded images isn't capped by exec's maxBuffer. Returns { records, atStart }
 * where atStart is true once the whole file fits in `k` (nothing older remains).
 */
export async function readTranscriptTail(agent, host, k) {
  const file = await resolveTranscriptFile(agent, host);
  if (!file) return { records: [], atStart: true };
  const { file: cmd, args } = tailReadArgs(host, file, k);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (lines) => {
      if (done) return;
      done = true;
      const records = [];
      for (const l of lines) {
        try { records.push(JSON.parse(l)); } catch { /* skip malformed */ }
      }
      resolve({ records, atStart: lines.length < k });
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ records: [], atStart: true });
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish([]));
    child.on('close', () => finish(out.split('\n').map((s) => s.trim()).filter(Boolean)));
  });
}

/**
 * Setup the read-only transcript WebSocket server.
 *
 * Protocol (server -> client, JSON frames):
 *   { type: 'record', record: <parsed JSONL object> }  // one per line, in order
 *   { type: 'error',  message }                          // fatal; connection closes
 *   { type: 'end' }                                      // the tail process exited
 *
 * There are no client -> server messages (sending uses POST /api/agents/:id/input).
 */
export function setupTranscriptWS(wss) {
  wss.on('connection', async (ws, request) => {
    let child = null;
    let closed = false;
    let pollTimer = null;

    const killChild = () => {
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        child = null;
      }
    };

    const cleanup = () => {
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      killChild();
    };

    // Attach teardown BEFORE any await so a ws that closes during transcript
    // resolution (or while polling/waiting for the file) still tears down.
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    try {
      const url = new URL(request.url, 'http://localhost');
      const agentId = url.searchParams.get('agent');
      if (!agentId) {
        return fail(ws, 'Agent id required');
      }

      const agent = getAgent(agentId);
      if (!agent) {
        return fail(ws, 'Agent not found');
      }

      const host = agent.host_id ? getHost(agent.host_id) : null;
      if (agent.host_id && !host) {
        return fail(ws, 'Unknown host');
      }

      // Spawn a follow-tail on a resolved transcript path and stream its records.
      const startTail = (filePath) => {
        if (closed || ws.readyState !== ws.OPEN) return;

        const { file, args } = tailSpawnArgs(host, filePath);
        child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // The connection may have closed between the check and spawn.
        if (closed) {
          killChild();
          return;
        }

        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;

          // Guard against a single pathological line that never terminates.
          if (buffer.length > MAX_LINE_BYTES && buffer.indexOf('\n') === -1) {
            buffer = '';
            return;
          }

          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const trimmed = line.trim();
            if (!trimmed) continue;
            let record;
            try {
              record = JSON.parse(trimmed);
            } catch {
              continue; // skip malformed / partial lines
            }
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'record', record }));
            }
          }
        });

        // tail/ssh diagnostics go to stderr; not fatal on their own.
        child.stderr.on('data', () => {});

        child.on('exit', () => {
          child = null;
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'end' }));
          }
        });

        child.on('error', (err) => {
          child = null;
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
          }
        });
      };

      const filePath = await resolveTranscriptFile(agent, host);
      if (closed || ws.readyState !== ws.OPEN) return;

      if (filePath) {
        startTail(filePath);
      } else {
        // No transcript yet: a freshly started Claude agent only writes its JSONL
        // after the first turn. Don't error — keep the socket open (the client
        // shows an empty "send a message" state) and poll until the file appears,
        // then start tailing so the first exchange streams in seamlessly.
        pollTimer = setInterval(async () => {
          if (closed || child) return;
          let fp = null;
          try {
            fp = await resolveTranscriptFile(agent, host);
          } catch {
            return;
          }
          if (fp && !closed && !child) {
            clearInterval(pollTimer);
            pollTimer = null;
            startTail(fp);
          }
        }, 2000);
      }
    } catch (err) {
      cleanup();
      fail(ws, err.message);
    }
  });
}

function fail(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
    ws.close();
  }
}
