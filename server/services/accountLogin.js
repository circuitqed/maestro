/**
 * Signing an additional Anthropic account in on a host, driven from the chat.
 *
 * WHY THIS EXISTS, rather than "just run claude /login over ssh":
 *
 * `claude /login` writes its credentials into whichever CLAUDE_CONFIG_DIR the shell
 * happens to have. Run from a plain pane to add a SECOND account, it overwrites the
 * FIRST one — that is not a hypothetical, it destroyed the personal Max credential on
 * garage-wsl and silently moved 16 agents onto a subscription that was at 98%, while
 * the account it was meant to refresh stayed expired. The dir has to be named
 * explicitly, every time, and a human doing that by hand will eventually not.
 *
 * So the config dir is baked into the session's command here. There is no code path
 * in this module that starts a login without CLAUDE_CONFIG_DIR pointing at the
 * alternate dir, which makes clobbering the default structurally impossible rather
 * than a thing to remember.
 *
 * It is interactive, hence a tmux session and a card instead of a single request:
 * Claude asks which login method, then prints an OAuth URL and waits for the code
 * you get back from the browser. Those are just pane text, so the chat can show them
 * and type into them — the same trick ConnectionCard uses for Sherlock's Duo prompt.
 *
 * Three things a fresh config dir does that would otherwise derail the card, all
 * found by running it:
 *
 * 1. FIRST-RUN WIZARD. A brand new dir opens on the theme picker, so the card's first
 *    screen would be "choose the text style that looks best with your terminal"
 *    instead of a login. Seeding `hasCompletedOnboarding` skips it.
 *
 * 2. TRUST PROMPT. With onboarding skipped it then asks whether you trust the working
 *    directory. Rather than pre-accepting trust for the user's real code — not our
 *    decision to make — the login runs in a dedicated empty directory inside the
 *    account dir, and only THAT path is pre-trusted. Trusting an empty folder we just
 *    created decides nothing.
 *
 * 3. THE URL IS WRAPPED BY THE TUI, NOT BY TMUX. Claude draws the authorize URL
 *    broken across pane lines, so they are separate lines rather than one wrapped
 *    line, and `capture-pane -J` does NOT rejoin them: at 120 columns the URL came
 *    back as 120 chars with `state=` missing — a link that looks fine and cannot work.
 *    The fix is a pane wider than the URL. Measured at 465 chars, so the session is
 *    created at 1000 columns and the whole URL lands on one line.
 */
import { execOnHost, shellQuote } from './hosts.js';
import { sessionExists, killSession, sendText, sendKeys, ensureTmuxServer } from './tmux.js';
import { listAccounts } from './accounts.js';

// The name becomes a directory, a tmux session name and part of a shell command.
// Keep it to the charset tmux session names already validate against, so it can
// never need quoting games: lowercase start, then alnum/dot/dash/underscore.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,30}$/;

// Wide enough that the ~465-char authorize URL is never wrapped. See note 3 above;
// this is the whole reason the shared createSession (fixed at 120) is not used.
const LOGIN_COLS = 1000;
const LOGIN_ROWS = 50;

export function isValidAccountName(name) {
  return NAME_RE.test(String(name || ''));
}

/** tmux session that holds one account's login. One per account name per host. */
export function loginSessionName(name) {
  return `acct-login-${name}`;
}

/**
 * Where the account lives. `$HOME` is deliberately left for the remote shell to
 * expand — the same reason accounts.js does: the path we hand to Claude has to be
 * absolute (it rejects a relative CLAUDE_CONFIG_DIR) and `~` would never expand
 * inside the single-quoted command built for tmux.
 */
const DIR_EXPR = (name) => `"$HOME/.claude-accts/${name}"`;

/**
 * Create the account dir, its dedicated login cwd, and a seeded .claude.json —
 * unless a login was already completed there, in which case nothing is touched.
 *
 * The seed is written via base64 so no JSON quoting has to survive the trip through
 * ssh -> sh -> printf. Only three things are set, and all three exist purely to stop
 * the first-run flow asking questions the card cannot sensibly render.
 */
async function prepareDir(host, name) {
  const dir = DIR_EXPR(name);
  const version = await claudeVersion(host);
  const seed = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    ...(version ? { lastOnboardingVersion: version } : {}),
    // Trust ONLY the empty login dir. Resolved by the shell below, because we do not
    // know $HOME here and must not guess it.
    projects: { __LOGIN_CWD__: { hasTrustDialogAccepted: true } },
  };
  const b64 = Buffer.from(JSON.stringify(seed)).toString('base64');

  // `python3 - <<EOF` is avoided on purpose: the mac mini's /usr/bin/python3 may be
  // absent, and bash 3.2 there cannot parse a heredoc inside $(). sed is everywhere.
  const cmd =
    `set -e; mkdir -p ${dir}/login-cwd; ` +
    `if [ ! -f ${dir}/.claude.json ]; then ` +
    `printf %s ${shellQuote(b64)} | base64 -d ` +
    `| sed "s|__LOGIN_CWD__|$HOME/.claude-accts/${name}/login-cwd|" > ${dir}/.claude.json; ` +
    `fi; ` +
    `chmod 700 ${dir}; printf '%s\\n' "$HOME/.claude-accts/${name}"`;
  const { stdout } = await execOnHost(host, cmd, { timeout: 20000 });
  return String(stdout).trim();
}

/** Which claude version is on the host, for the onboarding stamp. Best effort. */
async function claudeVersion(host) {
  try {
    const { stdout } = await execOnHost(host, `bash -lc 'claude --version 2>/dev/null | head -1'`, { timeout: 20000 });
    const m = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(String(stdout));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Begin (or re-attach to) an interactive login for `name` on `host`.
 * @returns {Promise<{started:boolean, alreadyRunning?:boolean, dir:string}>}
 */
export async function beginAccountLogin(host, name) {
  if (!isValidAccountName(name)) throw new Error('Account name must be lowercase letters, numbers, . _ or -');
  const session = loginSessionName(name);
  const dir = await prepareDir(host, name);

  if (await sessionExists(session, host)) {
    return { started: false, alreadyRunning: true, dir };
  }

  await ensureTmuxServer(host);
  // bash -lc so a login shell resolves claude: ~/.local/bin is not on the PATH a
  // non-interactive ssh gets, which is the same reason hosts carry a path_prefix.
  //
  // CLAUDE_CONFIG_DIR is part of this string and there is no variant without it.
  const inner =
    `export CLAUDE_CONFIG_DIR="$HOME/.claude-accts/${name}"; ` +
    `cd "$CLAUDE_CONFIG_DIR/login-cwd" && claude /login; exec bash`;
  const command = `bash -lc ${shellQuote(inner)}`;

  const tmuxCmd =
    `tmux new-session -d -x ${LOGIN_COLS} -y ${LOGIN_ROWS} -s ${shellQuote(session)} ` +
    `-e MAESTRO_SESSION=${shellQuote(session)} ${shellQuote(command)}`;
  await execOnHost(host, tmuxCmd, { timeout: 30000 });
  return { started: true, dir };
}

/**
 * The login pane as text. Captured WITHOUT -J: at this pane width nothing wraps, and
 * -J would not have fixed it anyway (see note 3).
 */
export async function accountLoginPane(host, name) {
  const session = loginSessionName(name);
  if (!(await sessionExists(session, host))) return null;
  const { stdout } = await execOnHost(host, `tmux capture-pane -t ${shellQuote(`=${session}:`)} -p`, { timeout: 20000 });
  return stdout;
}

/**
 * Type an answer into the login — the OAuth code, or anything else it asks for.
 *
 * verify:false, like the Sherlock card: sendText's default waits to see its own text
 * echoed back before pressing Enter, and Claude's input box does not echo predictably
 * (it redraws the whole TUI), so verification would withhold the Enter and the login
 * would sit there looking stuck.
 */
export async function accountLoginInput(host, name, text) {
  const session = loginSessionName(name);
  if (!(await sessionExists(session, host))) throw new Error('No login in progress');
  return sendText(session, text, host, { verify: false });
}

export async function accountLoginKeys(host, name, keys) {
  const session = loginSessionName(name);
  if (!(await sessionExists(session, host))) throw new Error('No login in progress');
  return sendKeys(session, keys, host);
}

/**
 * Has this account got a credential yet, and whose is it?
 *
 * Asks accounts.js rather than re-implementing the probe, so "signed in" means
 * exactly what the account picker means by it — including that a credential file
 * existing is not the same as the account being usable.
 */
export async function accountLoginStatus(host, name) {
  const session = loginSessionName(name);
  const [running, accounts] = await Promise.all([
    sessionExists(session, host),
    listAccounts(host).catch(() => []),
  ]);
  const acct = accounts.find((a) => a.dir.endsWith(`/.claude-accts/${name}`)) || null;
  return {
    name,
    running,
    signedIn: !!(acct && acct.loggedIn),
    usable: !!(acct && acct.usable),
    email: acct ? acct.email : null,
    detail: acct ? acct.detail : null,
    dir: acct ? acct.dir : null,
  };
}

/**
 * Stop a login in progress.
 *
 * `discard` removes the account dir, but only when no credential landed — a
 * half-finished dir shows up in the picker as "not signed in" and is just litter,
 * while a dir that DID complete is the account itself and must survive a cancel.
 */
export async function cancelAccountLogin(host, name, { discard = false } = {}) {
  if (!isValidAccountName(name)) throw new Error('Invalid account name');
  const session = loginSessionName(name);
  try {
    await killSession(session, host);
  } catch {
    /* nothing running */
  }
  let removed = false;
  if (discard) {
    const { signedIn } = await accountLoginStatus(host, name);
    if (!signedIn) {
      await execOnHost(host, `rm -rf ${DIR_EXPR(name)}`, { timeout: 20000 });
      removed = true;
    }
  }
  return { ok: true, removed };
}

/**
 * Tidy up after a completed login: the credential is written, so the TUI sitting
 * there serves no purpose and would hold a Claude process open indefinitely.
 */
export async function finishAccountLogin(host, name) {
  const status = await accountLoginStatus(host, name);
  if (status.signedIn && status.running) {
    try {
      await killSession(loginSessionName(name), host);
    } catch {
      /* already gone */
    }
  }
  return status;
}
