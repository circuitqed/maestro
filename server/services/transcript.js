import { spawn } from 'child_process';
import { URL } from 'url';
import {
  execOnHost,
  shellQuote,
  isRemote,
  sshBaseArgs,
  remoteWrap,
} from './hosts.js';
import { getAgent, getHost, getProject } from './db.js';
import { resolveWorkingDir } from './projectPaths.js';

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

/**
 * Locate a Codex agent's rollout transcript. Codex stores sessions as
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, organised by DATE (not
 * cwd), and the first line (session_meta) records the cwd. So: scan the newest
 * rollout files and return the first whose session_meta cwd matches the agent's
 * working directory. Host-aware; returns an absolute path (valid on host) or null.
 */
export async function resolveCodexTranscriptFile(host, cwd) {
  if (!cwd) return null;
  const needle = `"cwd":"${cwd}"`; // matched literally against line 1 (session_meta)
  const script =
    `ls -t "$HOME/.codex/sessions"/*/*/*/rollout-*.jsonl 2>/dev/null | head -50 | while read f; do ` +
    `head -1 "$f" | grep -qF ${shellQuote(needle)} && { echo "$f"; break; }; done`;
  try {
    const { stdout } = await execOnHost(host, script);
    return firstLine(stdout);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The trailing UUID of a Codex rollout filename
// (rollout-<ISO ts>-<uuid>.jsonl); null if the name doesn't match.
function rolloutIdFromPath(p) {
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(p || '');
  return m ? m[1] : null;
}

// Locate the exact rollout for a pinned Codex session id (captured at start). This is
// what lets two Codex agents sharing a working dir resolve to their own transcripts.
export async function findCodexRolloutById(host, id) {
  if (!isUuid(id)) return null;
  // `id` is validated hex+dashes, so it is safe to inline; the * do the globbing.
  const script = `ls -t "$HOME/.codex/sessions"/*/*/*/rollout-*-${id}.jsonl 2>/dev/null | head -1`;
  try {
    const { stdout } = await execOnHost(host, script);
    return firstLine(stdout);
  } catch {
    return null;
  }
}

// UUIDs of the rollouts whose session_meta cwd matches `cwd` (newest first). Used to
// diff before/after a Codex start and capture the freshly created session's id.
export async function listCodexRolloutIdsForCwd(host, cwd) {
  if (!cwd) return [];
  const needle = `"cwd":"${cwd}"`;
  const script =
    `ls -t "$HOME/.codex/sessions"/*/*/*/rollout-*.jsonl 2>/dev/null | head -80 | while read f; do ` +
    `head -1 "$f" | grep -qF ${shellQuote(needle)} && echo "$f"; done`;
  try {
    const { stdout } = await execOnHost(host, script);
    return String(stdout || '')
      .split('\n')
      .map((s) => rolloutIdFromPath(s.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Poll (bounded) for a rollout that appeared after a Codex start — i.e. a matching-cwd
// rollout id not present in `beforeIds`. Returns the new id, or null on timeout.
// Best-effort: callers must treat null as "leave unpinned, fall back to cwd match".
export async function captureCodexRolloutId(host, cwd, beforeIds, tries = 12, delayMs = 600) {
  if (!cwd) return null;
  const before = new Set(beforeIds || []);
  for (let i = 0; i < tries; i++) {
    const ids = await listCodexRolloutIdsForCwd(host, cwd);
    const fresh = ids.find((id) => !before.has(id)); // ids are newest-first
    if (fresh) return fresh;
    await sleep(delayMs);
  }
  return null;
}

export async function resolveTranscriptFile(agent, host) {
  // Codex keeps its own transcript format/location — resolve by matching the
  // rollout's recorded cwd to this agent's (host-aware) working directory. A pinned
  // session id (captured at start) takes precedence so that multiple Codex agents
  // sharing one working dir each resolve to their own rollout instead of collapsing
  // onto the single newest one.
  if (agent && agent.config && agent.config.provider === 'codex') {
    if (agent.claude_session_id && isUuid(agent.claude_session_id)) {
      const pinned = await findCodexRolloutById(host, agent.claude_session_id);
      if (pinned) return pinned;
    }
    const project = agent.project_id ? getProject(agent.project_id) : null;
    const cwd = project ? resolveWorkingDir(project, host) : null;
    return resolveCodexTranscriptFile(host, cwd);
  }

  // 1. Pinned session id: the transcript filename equals the session id.
  if (agent && agent.claude_session_id && isUuid(agent.claude_session_id)) {
    const pinned = await findPinnedTranscript(host, agent.claude_session_id);
    if (pinned) return pinned;
  }

  // 2. Fallback: newest *.jsonl in the project's encoded-cwd folder.
  if (agent && agent.project_id) {
    const project = getProject(agent.project_id);
    if (project && project.path) {
      const enc = encodeCwd(project.path);
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
      remoteWrap(host, `exec tail -n ${INITIAL_TAIL_LINES} -F ${shellQuote(filePath)}`),
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
