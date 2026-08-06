import { randomUUID } from 'crypto';
import { execOnHost, shellQuote } from './hosts.js';

/**
 * Shell-quoted EXACT target for a tmux `-t` argument.
 *
 * tmux treats `-t <name>` as a PATTERN, not a literal: it prefix-matches, so
 * `-t maestro` silently resolves to a session named `maestro_shell` when no
 * exact `maestro` exists. That made two agents whose names are prefixes of one
 * another share one session (input, capture, kill and attach all hit the wrong
 * one). The `=` prefix forces an exact-name match.
 */
function target(sessionName) {
  return shellQuote(`=${sessionName}`);
}

/**
 * Shell-quoted EXACT target for commands taking a target-PANE rather than a
 * target-session (send-keys, paste-buffer, capture-pane).
 *
 * A bare `=name` is not a valid pane target ("can't find pane"); the session must
 * be qualified with a trailing `:` so tmux resolves it to that session's active
 * window/pane — `=name:` — while still matching the session name exactly.
 */
function paneTarget(sessionName) {
  return shellQuote(`=${sessionName}:`);
}

/**
 * Get list of available tmux sessions
 * @param {object|null} host - Host row (null => local)
 */
export async function getTmuxSessions(host = null) {
  try {
    const { stdout } = await execOnHost(host, 'tmux list-sessions -F "#{session_name}:#{session_attached}"');
    const lines = stdout.trim().split('\n').filter(Boolean);

    return lines.map((line) => {
      const [name, attached] = line.split(':');
      return {
        name,
        status: attached === '1' ? 'attached' : 'detached',
      };
    });
  } catch (err) {
    // tmux returns exit code 1 when no sessions exist
    if (err.code === 1 || err.message.includes('no server running')) {
      return [];
    }
    throw err;
  }
}

/**
 * Check if a tmux session exists
 */
export async function sessionExists(sessionName, host = null) {
  try {
    await execOnHost(host, `tmux has-session -t ${target(sessionName)} 2>/dev/null`);
    return true;
  } catch (err) {
    // tmux has-session exits 1 when the session/server genuinely doesn't exist.
    // Anything else (ssh 255, ConnectTimeout, execFile timeout) means the host
    // state is unknown — surface it so callers don't treat "unreachable" as "gone".
    if (err.code === 1) return false;
    throw err;
  }
}

// Commands that mean "this pane is sitting at a prompt", i.e. whatever the session
// was supposed to run is not running. Deliberately just the shells: anything else
// (node, python, claude, codex, ssh, vim…) counts as a live program.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', '-zsh', '-bash']);

/**
 * Is this session sitting at a bare shell prompt with nothing running in it?
 *
 * `pane_current_command` alone is NOT enough: a provider is launched as
 * `bash -lc 'claude …; exec bash'`, and tmux reports that pane as **bash** while
 * Claude is running happily inside it. Treating that as idle typed the launch
 * command into a live agent as a chat message. So also require the pane's process
 * to have no children — a bare shell has none, a shell running a provider has the
 * provider as a child.
 *
 * Unknown/unreadable => false, so we never disturb a session we can't inspect.
 */
export async function sessionIsBareShell(sessionName, host = null) {
  try {
    const { stdout } = await execOnHost(
      host,
      // Split with awk, NOT `set -- $info`: ssh runs the host's login shell, which
      // on macOS is zsh — and zsh does not word-split an unquoted expansion. That
      // left the pid empty and the command as the whole "zsh 1234" string, so every
      // Mac session looked non-idle and adoption silently stopped working there.
      `info=$(tmux list-panes -t ${paneTarget(sessionName)} -F '#{pane_current_command} #{pane_pid}' | head -1); ` +
        `cmd=$(printf '%s\\n' "$info" | awk '{print $1}'); ` +
        `pid=$(printf '%s\\n' "$info" | awk '{print $2}'); ` +
        `kids=$(pgrep -P "$pid" 2>/dev/null | head -1); ` +
        `echo "$cmd ${'${kids:-none}'}"`
    );
    const [cmd, kids] = String(stdout).trim().split(/\s+/);
    if (!cmd) return false;
    const isShell = SHELL_COMMANDS.has(cmd.replace(/^-/, '').toLowerCase());
    return isShell && kids === 'none';
  } catch {
    return false;
  }
}

/**
 * Make sure the tmux server is up and any restore-on-start has finished, before
 * we decide whether an agent's session exists.
 *
 * The Mac mini runs tmux-continuum with `@continuum-restore on`. When no server is
 * running, the FIRST tmux command starts one — which fires tmux-resurrect's
 * restore, recreating the whole saved session set as bare shells in their saved
 * directories. That raced with Maestro's own `new-session`: the create hung (one
 * was still stuck after 3 minutes, orphaned on the host because our ssh had
 * already timed out at 15s), and the agent ended up bound to a restored husk
 * sitting in some unrelated project's directory — "it restored a tmux session into
 * a random directory".
 *
 * So start the server deliberately, wait for the session set to stop changing,
 * and only then look. Best-effort: on any failure we just proceed as before.
 */
export async function ensureTmuxServer(host = null) {
  const script = [
    // Already up? Then there is no restore to wait for — report and return.
    `if tmux list-sessions >/dev/null 2>&1; then tmux list-sessions 2>/dev/null | wc -l | tr -d " "; exit 0; fi`,
    // We are starting it, so a restore is likely about to run. Give it a grace
    // period BEFORE watching for stability: the restore takes a moment to begin,
    // and two early polls of "0 sessions" otherwise look stable and we'd return
    // while the restore was still to come — which is exactly what raced before.
    `tmux start-server >/dev/null 2>&1 || true`,
    `sleep 2`,
    `prev=-1; stable=0; i=0; n=0`,
    `while [ "$i" -lt 60 ]; do`,
    `  n=$(tmux list-sessions 2>/dev/null | wc -l | tr -d " ")`,
    `  if [ "$n" = "$prev" ]; then stable=$((stable+1)); else stable=0; fi`,
    `  [ "$stable" -ge 3 ] && break`,
    `  prev=$n; i=$((i+1)); sleep 0.5`,
    `done`,
    `echo "$n"`,
  ].join('\n');
  try {
    const { stdout } = await execOnHost(host, script, { timeout: 60000 });
    return parseInt(String(stdout).trim(), 10) || 0;
  } catch {
    return 0; // never block a start on this
  }
}

/**
 * Create a new tmux session and optionally run a command
 * @param {string} sessionName - Name for the tmux session
 * @param {string} workingDir - Working directory for the session
 * @param {string} command - Command to run in the session
 * @param {object|null} host - Host row (null => local)
 */
export async function createSession(sessionName, workingDir = null, command = null, host = null) {
  await ensureTmuxServer(host); // let any continuum restore settle first
  // Check if session already exists
  if (await sessionExists(sessionName, host)) {
    return { name: sessionName, created: false, message: 'Session already exists' };
  }

  // Build the tmux command
  let tmuxCmd = `tmux new-session -d -s ${shellQuote(sessionName)}`;

  if (workingDir) {
    tmuxCmd += ` -c ${shellQuote(workingDir)}`;
  }

  if (command) {
    // Run command with exec bash fallback so session stays open
    tmuxCmd += ` ${shellQuote(`${command}; exec bash`)}`;
  }

  await execOnHost(host, tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Start a provider agent session with a given command
 * @param {string} sessionName - Name for the tmux session
 * @param {string} command - Shell command to run (e.g. "bash -lc 'claude --dangerously-skip-permissions; exec bash'")
 * @param {string} workingDir - Project path as working directory
 * @param {object|null} host - Host row (null => local)
 */
export async function startProviderSession(sessionName, command, workingDir = null, host = null) {
  await ensureTmuxServer(host); // let any continuum restore settle before we look
  if (await sessionExists(sessionName, host)) {
    // A session with the right NAME is not proof the provider is running in it.
    // The Mac mini restores its whole session set via tmux-continuum, and
    // tmux-resurrect brings panes back as bare shells (it doesn't re-run the
    // programs), so a restored `puzzleparlor-mini` looked "already running" while
    // Claude had never started — the agent showed green and was a plain zsh prompt.
    // Same trap for a session the user made by hand under a colliding name.
    // If the pane is idle at a prompt, launch the provider into it rather than
    // reporting a success that didn't happen. A session with something already
    // running is left strictly alone.
    if (await sessionIsBareShell(sessionName, host)) {
      // cd first: a restored pane keeps whatever directory it was saved in, which
      // need not be this agent's working dir (a restore had `inkglass` sitting in
      // the hot-qubits directory), and the provider must start in the right place.
      const line = workingDir ? `cd ${shellQuote(workingDir)} && ${command}` : command;
      await sendText(sessionName, line, host);
      return { name: sessionName, created: true, adopted: true };
    }
    return { name: sessionName, created: false, alreadyRunning: true };
  }

  let tmuxCmd = `tmux new-session -d -s ${shellQuote(sessionName)}`;

  if (workingDir) {
    tmuxCmd += ` -c ${shellQuote(workingDir)}`;
  }

  tmuxCmd += ` ${shellQuote(command)}`;

  await execOnHost(host, tmuxCmd);
  return { name: sessionName, created: true };
}

/**
 * Start a Claude agent session (backward compatibility)
 */
export async function startAgentSession(sessionName, workingDir = null) {
  const command = "bash -lc '/home/dave/.local/bin/claude --dangerously-skip-permissions; exec bash'";
  return startProviderSession(sessionName, command, workingDir);
}

/**
 * Kill a tmux session
 */
export async function killSession(sessionName, host = null) {
  try {
    await execOnHost(host, `tmux kill-session -t ${target(sessionName)}`);
    return { name: sessionName, killed: true };
  } catch (err) {
    if (err.message.includes('session not found') || err.message.includes("can't find session")) {
      return { name: sessionName, killed: false, message: 'Session not found' };
    }
    throw err;
  }
}

/**
 * Send keys to a tmux session
 */
export async function sendKeys(sessionName, keys, host = null) {
  await execOnHost(host, `tmux send-keys -t ${paneTarget(sessionName)} "${keys}"`);
}

/**
 * Inject a literal block of text into a tmux session as if typed, then press Enter.
 *
 * Unlike sendKeys (which interpolates the argument as tmux KEY NAMES, so "Enter"
 * or "C-c" would be interpreted), this pastes `text` verbatim via the tmux paste
 * buffer — words like "Enter", newlines, quotes, and shell metacharacters are all
 * inert. `text` is passed as a single shell-quoted argument so it cannot break out
 * at the local sh (or the remote ssh login shell) layer. A per-call named buffer
 * avoids racing on tmux's global buffer stack when multiple sends overlap.
 *
 * @param {string} sessionName - Target tmux session
 * @param {string} text - Literal text to inject (no trailing newline needed)
 * @param {object|null} host - Host row (null => local)
 */
export async function sendText(sessionName, text, host = null) {
  const buf = `maestro-${randomUUID()}`;
  const s = paneTarget(sessionName); // paste-buffer/send-keys take a pane target
  // Paste the text, then submit with Enter as a SEPARATE step after a short pause.
  // The Claude Code / Codex TUIs ingest a bracketed paste asynchronously, so an
  // Enter sent in the same instant can arrive before the paste is committed to the
  // input and get dropped — the message ends up typed but never sent (intermittent,
  // worse over a laggy remote). The delay lets the paste settle before we submit.
  const cmd =
    `tmux set-buffer -b ${shellQuote(buf)} -- ${shellQuote(text)} && ` +
    `tmux paste-buffer -d -b ${shellQuote(buf)} -t ${s} && ` +
    `sleep 0.5 && ` +
    `tmux send-keys -t ${s} Enter`;
  await execOnHost(host, cmd);
}

/**
 * Answer an interactive numbered select (e.g. Claude Code's AskUserQuestion) by
 * pressing the option's number key, which selects and submits it immediately.
 *
 * @param {string} sessionName - Target tmux session
 * @param {number} choice - The option number (1-9) to press
 * @param {object|null} host - Host row (null => local)
 */
export async function sendAnswer(sessionName, choice, host = null) {
  const digit = String(parseInt(choice, 10));
  if (!/^[1-9]$/.test(digit)) throw new Error('choice must be 1-9');
  await execOnHost(host, `tmux send-keys -t ${paneTarget(sessionName)} ${shellQuote(digit)}`);
}

/**
 * Capture the current visible pane content of a session (for detecting an active
 * interactive prompt that isn't in the transcript yet).
 */
export async function capturePane(sessionName, host = null) {
  const { stdout } = await execOnHost(host, `tmux capture-pane -t ${paneTarget(sessionName)} -p`);
  return stdout;
}
