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
import { AGY_DIR, agyConversationFromPath, transcriptLineParser } from './agyTranscript.js';

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
/**
 * The agent's Claude config home as a shell expression.
 *
 * Transcripts live INSIDE the config dir, so an agent running under a second
 * Anthropic account (CLAUDE_CONFIG_DIR set, see providers.claudeConfigDir) writes
 * them somewhere other than ~/.claude -- and the locator has to look where that
 * agent actually writes.
 *
 * Getting this wrong is not cosmetic. pinnedTranscriptExists decides --session-id
 * vs --resume; if it always answers "no file" the agent is restarted with
 * --session-id for a uuid that already exists, Claude refuses it, and the agent
 * becomes unstartable.
 */
function claudeHomeExpr(configDir) {
  // Default stays double-quoted so $HOME expands on the remote shell; an explicit
  // dir is single-quoted like every other value crossing a shell boundary.
  return configDir ? shellQuote(configDir) : '"$HOME/.claude"';
}

// The config dir recorded on an agent row, if any. Tolerates a missing/!object
// config and never throws -- the locator must degrade to the default, not fail.
export function agentClaudeHome(agent) {
  const dir = agent && agent.config && agent.config.claudeConfigDir;
  return typeof dir === 'string' && dir.startsWith('/') ? dir : null;
}

export async function findPinnedTranscript(host, sessionId, configDir = null) {
  if (!isUuid(sessionId)) return null;
  try {
    // "$HOME" is double-quoted so it expands; the -name arg is shell-quoted.
    const { stdout } = await execOnHost(
      host,
      `find ${claudeHomeExpr(configDir)}/projects -maxdepth 2 -name ${shellQuote(
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
export async function pinnedTranscriptExists(host, sessionId, configDir = null) {
  return !!(await findPinnedTranscript(host, sessionId, configDir));
}

/**
 * Bring a session's transcript over from another account on this host, so an agent
 * switched to a different account RESUMES its conversation instead of starting blank.
 *
 * Transcripts live inside the config dir, so after a switch (work ran out of usage,
 * em-sim-main moved to stanford-api) the pinned file is "absent" under the new
 * account, start chose --session-id, and the agent came up with an empty
 * conversation while its real one sat in ~/.claude-accts/work. Copying it (with its
 * sidecar dir of subagent and tool-result files) into the same project folder under
 * the new account is what lets --resume find it. A copy, not a move: the old
 * account's history stays intact.
 *
 * Returns the new path, or null when no other account has it.
 */
export async function adoptTranscriptFromOtherAccount(host, sessionId, configDir = null) {
  if (!isUuid(sessionId)) return null;
  const name = shellQuote(`${sessionId}.jsonl`);
  const dest = claudeHomeExpr(configDir);
  try {
    const { stdout } = await execOnHost(
      host,
      `src=$(ls -t "$HOME"/.claude/projects/*/${name} "$HOME"/.claude-accts/*/projects/*/${name} 2>/dev/null | head -1); ` +
        '[ -z "$src" ] && exit 0; ' +
        `dst=${dest}/projects/$(basename "$(dirname "$src")"); ` +
        '[ "$src" = "$dst/$(basename "$src")" ] && exit 0; ' +
        'mkdir -p "$dst" && cp -p "$src" "$dst/" && ' +
        '{ [ ! -d "${src%.jsonl}" ] || cp -rp "${src%.jsonl}" "$dst/"; } && ' +
        'echo "$dst/$(basename "$src")"',
      { timeout: 60000 }
    );
    return firstLine(stdout);
  } catch {
    return null;
  }
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

/**
 * Locate an Antigravity agent's transcript (format and translation: agyTranscript.js).
 *
 * agy holds `presence/<conversation-id>.lock` open for as long as a conversation is
 * live, so the pane's own process names its conversation exactly — the same "ask
 * the live process" rule as Codex, without the mtime guessing. Then, for a stopped
 * agent: the pinned id, then agy's own cache/last_conversations.json, which maps
 * each workspace directory to the conversation last used there.
 *
 * `agyHome` is the agent's alternate HOME (an account other than the default), or
 * null for the real one. Returns an absolute host path, or null.
 */
export async function resolveAgyTranscript(host, sessionName, agyHome, cwd, pinnedId) {
  if (!sessionName || !isValidSessionName(sessionName)) return null;
  const base = agyHome ? `${shellQuote(agyHome)}/${AGY_DIR}` : `"$HOME"/${AGY_DIR}`;
  const script = [
    `S=${shellQuote(sessionName)}; C=${shellQuote(cwd || '')}; P=${shellQuote(isUuid(pinnedId) ? pinnedId : '')}; B=${base}`,
    // The full stream when present; transcript.jsonl has long fields cut short.
    `t(){ for n in transcript_full.jsonl transcript.jsonl; do f="$B/brain/$1/.system_generated/logs/$n"; [ -f "$f" ] && { echo "$f"; return 0; }; done; return 1; }`,
    `m(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }`,
    // pane -> bash -lc -> agy: the same two generations the Codex lookup walks.
    `pane=$(tmux list-panes -t "=$S:" -F '#{pane_pid}' 2>/dev/null | head -1)`,
    `if [ -n "$pane" ]; then`,
    `  kids=$(pgrep -P "$pane" 2>/dev/null)`,
    `  gkids=$(printf '%s\\n' "$kids" | grep -v '^$' | while read -r k; do pgrep -P "$k" 2>/dev/null; done)`,
    `  ids=$(printf '%s\\n%s\\n%s' "$pane" "$kids" "$gkids" | grep -v '^$' | sort -u | while read -r p; do`,
    `      ls -l "/proc/$p/fd" 2>/dev/null | sed -n 's|.*/presence/\\([0-9a-fA-F-]\\{36\\}\\)\\.lock$|\\1|p'`,
    `      lsof -p "$p" -Fn 2>/dev/null | sed -n 's|^n.*/presence/\\([0-9a-fA-F-]\\{36\\}\\)\\.lock$|\\1|p'`,
    `    done | sort -u)`,
    // More than one lock has never been seen; if it happens, the most recently
    // written conversation is the one being talked to.
    `  f=$(printf '%s\\n' "$ids" | grep -v '^$' | while read -r i; do x=$(t "$i") && printf '%s\\t%s\\n' "$(m "$x")" "$x"; done | sort -rn | head -1 | cut -f2)`,
    `  [ -n "$f" ] && { echo "$f"; exit 0; }`,
    `fi`,
    `[ -n "$P" ] && t "$P" && exit 0`,
    `[ -n "$C" ] || exit 0`,
    `i=$(grep -F "\\"$C\\":" "$B/cache/last_conversations.json" 2>/dev/null | sed -n 's|.*: *"\\([0-9a-fA-F-]\\{36\\}\\)".*|\\1|p' | head -1)`,
    `[ -n "$i" ] && t "$i"`,
  ].join('\n');
  try {
    const { stdout } = await execOnHost(host, script);
    return firstLine(stdout) || null;
  } catch {
    return null;
  }
}

/**
 * Whether a pinned Codex rollout still exists on the host — the Codex counterpart of
 * pinnedTranscriptExists. Codex names its rollouts rollout-<ts>-<uuid>.jsonl under a
 * date hierarchy, so the id has to be globbed for rather than looked up by path.
 */
export async function codexRolloutExists(host, sessionId) {
  if (!isUuid(sessionId)) return false;
  try {
    const { stdout } = await execOnHost(
      host,
      `ls -1 "$HOME"/.codex/sessions/*/*/*/rollout-*-${sessionId}.jsonl 2>/dev/null | head -1`
    );
    return !!String(stdout).trim();
  } catch {
    return false; // unreachable or no match — start fresh rather than fail
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

  // Antigravity: its own files, located from the live process (see
  // resolveAgyTranscript), and never Claude's folders, where the search below could
  // only turn up another agent's conversation from the same directory.
  if (agent && agent.config && agent.config.provider === 'antigravity') {
    const project = agent.project_id ? getProject(agent.project_id) : null;
    const cwd = resolveAgentWorkingDir(agent, project, host);
    const file = await resolveAgyTranscript(
      host,
      agent.screen_session,
      agent.config.agyHome || null,
      cwd,
      agent.claude_session_id
    );
    // Pin it, as Codex does, so a stopped agent's chat still opens its last
    // conversation rather than whichever one agy last used in that directory.
    const id = agyConversationFromPath(file);
    if (id && id !== agent.claude_session_id) {
      try { setAgentClaudeSessionId(agent.id, id); } catch { /* optimisation only */ }
    }
    return file;
  }

  // 0. The id the live process was LAUNCHED with, used only to seed the search when
  //    the stored pin is missing or points at nothing. It is not an answer on its
  //    own: argv never changes, so it still names the original session long after
  //    claude has forked away from it (arxiver, launched 2026-08-12 with --resume
  //    cebf26c7, writing to 62622f73 since 09-03). Whatever it yields still goes
  //    through the lineage check below.
  let seedId = agent && agent.claude_session_id;
  if (agent && agent.screen_session && !(seedId && isUuid(seedId))) {
    const liveId = await liveSessionId(agent, host);
    if (liveId) seedId = liveId;
  }

  // 1. Pinned session id: the transcript filename equals the session id.
  //
  // The pin goes STALE on its own. Claude forks a new session id on compaction and
  // on /clear, keeps writing to the new file, and leaves the old one on disk --
  // existing, findable, and dead. Returning it unconditionally meant chat tailed a
  // transcript that had stopped growing ten hours earlier while the terminal showed
  // the live conversation: observed on em-sim-main, pinned b9dcd804 (last written
  // 00:26) while the session had moved on through bede917c to 7dc5ec60.
  //
  // So the pin is a hint, not an answer: if the agent's own directory holds a NEWER
  // transcript, that is the live one. The Codex branch above already re-pins this
  // way; this is the same rule for Claude.
  if (agent && seedId && isUuid(seedId)) {
    const pinned = await findPinnedTranscript(host, seedId, agentClaudeHome(agent));
    if (pinned) {
      const newer = await newerTranscriptInAgentDir(agent, host, pinned);
      if (!newer) return pinned;
      const id = transcriptIdFromPath(newer);
      // Re-pin, so a restart resumes the session the agent is actually in rather
      // than reviving a compacted-away one.
      if (id && id !== agent.claude_session_id) {
        try { setAgentClaudeSessionId(agent.id, id); } catch { /* optimisation only */ }
      }
      return newer;
    }
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
            `ls -t ${claudeHomeExpr(agentClaudeHome(agent))}/projects/${enc}/*.jsonl 2>/dev/null | head -1`
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


const transcriptIdFromPath = (p) => {
  const m = /([0-9a-fA-F-]{36})\.jsonl$/.exec(String(p || ''));
  return m ? m[1] : null;
};

/**
 * The successor to this agent's pinned session, when claude has forked away from it.
 *
 * claude starts a NEW session id on compaction and /clear, keeps writing there, and
 * leaves the old file behind. Three signals were tried before this one, and the
 * first two were wrong in production:
 *
 *   mtime  an abandoned transcript kept being touched, so it looked freshest while
 *          its newest record was 15 days old (EmailAssistant, 62622f73).
 *   argv   `--resume <id>` is only what the process was LAUNCHED with. arxiver was
 *          started 2026-08-12 with --resume cebf26c7; that file stopped receiving
 *          records on 09-03 and everything since went to 62622f73, argv unchanged.
 *
 * What does hold is LINEAGE: a forked transcript carries references to the session
 * it came from (62622f73 mentions cebf26c7 321 times). Selecting on "references my
 * pinned id AND has newer content" attributes correctly even where several agents
 * share one directory -- ~/.claude/projects/-home-dave holds a dozen -- which plain
 * "newest file wins" does not: whichever agent resolved first would steal it.
 *
 * Bounded to the five newest files so this stays a single command.
 */
async function newerTranscriptInAgentDir(agent, host, pinned) {
  const pinnedId = transcriptIdFromPath(pinned) || agent.claude_session_id;
  if (!pinnedId || !isUuid(pinnedId)) return null;
  // Anchor on the directory the PINNED transcript is actually in, not on a cwd
  // derived from the project row. arxiver's project has an empty path, so
  // resolveAgentWorkingDir returned null and this bailed before looking at
  // anything -- leaving it on a session abandoned six weeks earlier. The pinned
  // file's own directory is where that agent's sessions live, by definition, and
  // needs no configuration to be correct.
  const dir = pinned.replace(/\/[^/]*$/, '');
  if (!dir || dir === pinned) return null;
  // Per candidate: newest record timestamp, whether it descends from the pin, path.
  let lines;
  try {
    const { stdout } = await execOnHost(
      host,
      `for f in $(ls -t ${dir}/*.jsonl 2>/dev/null | head -5); do ` +
        `t=$(tail -c 200000 "$f" | grep -o '"timestamp":"[^"]*"' | tail -1 | grep -oE '[0-9T:.Z-]{20,}'); ` +
        // grep -c already prints 0 when nothing matches (exiting 1); a `|| echo 0`
        // here printed a SECOND 0 on its own line, splitting this file's record.
        `n=$(grep -c ${shellQuote(pinnedId)} "$f" 2>/dev/null); ` +
        `a=$(grep -m1 -o '"agentName":"[^"]*"' "$f" 2>/dev/null | sed 's/^"agentName":"//; s/"$//'); ` +
        `printf '%s|%s|%s|%s\n' "$t" "$n" "$f" "$a"; done`,
      { timeout: 25000 }
    );
    lines = String(stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const siblings = new Set(getPinnedSessionIdsOnHost(agent.id, agent.host_id) || []);
  let pinnedTs = null;
  const candidates = [];
  for (const line of lines) {
    const [ts, nRaw, file, ...rest] = line.split('|');
    const name = rest.join('|');
    // A blank timestamp means the probe failed to parse that file, not that the
    // file is old -- skipping silently is how a quoting bug in this very command
    // (BRE braces eaten by the template literal) made every candidate vanish.
    if (!ts || !file) continue;
    if (file === pinned) { pinnedTs = ts; continue; }
    const id = transcriptIdFromPath(file);
    if (id && siblings.has(id)) continue;         // another agent's session
    // Descendants only. A handful of incidental mentions is not lineage: the real
    // thing cites its parent hundreds of times (321 for arxiver), whereas an
    // unrelated transcript that happens to name the id does so a few times.
    //
    // Or a session claude recorded under this agent's own --name. /clear starts a
    // fresh transcript that cites its predecessor zero times, so lineage alone left
    // em-sim-main's chat on the pre-/clear file (005ca968) while the agent worked in
    // cdbf9587 -- whose agent-name record says em-sim-main.
    const named = !!name && name === agent.name;
    if (!named && (parseInt(nRaw, 10) || 0) < 10) continue;
    candidates.push({ ts, file });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const best = candidates[0];
  if (pinnedTs && pinnedTs >= best.ts) return null;   // the pin still has the newest content
  return best.file;
}

function firstLine(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || null;
}

/**
 * The session id the agent's LIVE process was launched with (--session-id or
 * --resume in the pane process's argv). Only a seed for resolveTranscriptFile —
 * argv never changes after a fork, so the lineage check there still applies.
 *
 * c8dd202 deleted this while keeping its one call, so every agent with no pinned
 * id threw "liveSessionId is not defined" and its chat showed only that error:
 * all Antigravity agents (never pinned) and any Claude agent whose pin was empty.
 *
 * Uses `ps` rather than /proc so it works on the mac mini too. Returns null for
 * anything unexpected; the caller falls back to the directory search.
 */
async function liveSessionId(agent, host) {
  const name = agent && agent.screen_session;
  if (!name || !isValidSessionName(name)) return null;
  const cmd =
    `pid=$(tmux list-panes -t ${shellQuote(`=${name}:`)} -F '#{pane_pid}' 2>/dev/null | head -1); ` +
    '[ -z "$pid" ] && exit 0; ' +
    'kids=$(pgrep -P "$pid" 2>/dev/null | tr "\n" "," | sed "s/,$//"); ' +
    '[ -z "$kids" ] && exit 0; ' +
    'ps -o args= -p "$kids" 2>/dev/null | ' +
    "grep -oE '(--resume|--session-id)[= ]+[0-9a-fA-F-]{36}' | grep -oE '[0-9a-fA-F-]{36}' | head -1";
  try {
    const { stdout } = await execOnHost(host, cmd, { timeout: 15000 });
    const id = firstLine(stdout);
    return id && isUuid(id) ? id : null;
  } catch {
    return null;  // agent stopped, host unreachable, no ps -- the directory search still works
  }
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
        // Killing the local ssh does NOT kill the remote tail by itself: `tail -F` on a
        // quiet transcript never writes, so it never notices the closed pipe.
        //
        // The previous fix heartbeat a blank line every 20s and relied on that write
        // FAILING once the channel died. On macOS it does not fail -- the write keeps
        // succeeding, the loop never exits, and the shell grows without bound. Six were
        // found on the Mac mini at 1.1-7.0 GB each (~0.6 GB/min, 20.7 GB on a 16 GB
        // box), all tailing one agent's transcript; killing them returned 6.9 GB at
        // once. Same zsh signature as both kernel panics.
        //
        // So key the lifetime to stdin rather than to a write succeeding. Maestro holds
        // the stdin pipe open and never writes to it; when the local ssh dies the remote
        // stdin hits EOF, `cat` returns, and the tail is killed. EOF is delivered by the
        // kernel on teardown instead of being inferred from an error code, so there is
        // nothing for a platform to disagree about.
      remoteWrap(
        host,
        `tail -n ${INITIAL_TAIL_LINES} -F ${shellQuote(filePath)} & tp=$!; ` +
          `trap 'kill $tp 2>/dev/null' EXIT HUP INT TERM PIPE; ` +
          `cat > /dev/null; kill $tp 2>/dev/null`
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
      const parse = transcriptLineParser(agent, file);
      for (const l of lines) {
        const r = parse(l);
        if (r) records.push(r);
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
        // stdin is a pipe held open and never written to: closing it (on kill, or
        // when Maestro exits) is what tells the remote shell to reap its tail.
        child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        // The connection may have closed between the check and spawn.
        if (closed) {
          killChild();
          return;
        }

        let buffer = '';
        const parse = transcriptLineParser(agent, filePath);
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
            const record = parse(trimmed); // null: malformed / partial / skipped line
            if (!record) continue;
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
