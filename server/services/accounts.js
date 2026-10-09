/**
 * Which Anthropic accounts are signed in on a host.
 *
 * Claude Code keeps credentials AND identity inside its config home, so a second
 * subscription is just a second config dir with its own login (see
 * providers.claudeConfigDir). That makes "which accounts exist here?" answerable by
 * looking at the filesystem -- no registry to keep in sync, nothing to go stale when
 * someone logs in or out at a terminal.
 *
 * Discovered, not configured, deliberately: a list the user has to maintain by hand
 * would drift from reality, and the failure mode is pointing an agent at an account
 * that is not actually logged in.
 *
 * Convention: the default account is ~/.claude, alternates live in ~/.claude-accts/<name>.
 */
import { execOnHost } from './hosts.js';

// Identity lives in .claude.json as oauthAccount.emailAddress. Read it with grep
// rather than a JSON parser: the file is ~50 KB and the remote host is reached over
// ssh, where python/node availability is not guaranteed but grep/sed always are.
// The identity file sits in DIFFERENT places for the two cases, which is easy to
// miss and silently hides the default account: with CLAUDE_CONFIG_DIR set it is
// <dir>/.claude.json, but the default account's lives at ~/.claude.json -- at the
// home root, NOT inside ~/.claude. Treat them separately rather than looping.
//
// $HOME is left for the remote shell to expand, so the dir we store on the agent is
// absolute: Claude rejects a relative CLAUDE_CONFIG_DIR, and "~" would never expand
// inside the single-quoted command built for tmux.
// .claude.json is pretty-printed -- `"emailAddress": "someone@example.com"` -- so the
// colon must be allowed to carry whitespace. A no-space pattern silently matches
// nothing and every account comes back anonymous.
const EMAIL_OF = (f) =>
  `grep -o '"emailAddress"[[:space:]]*:[[:space:]]*"[^"]*"' ${f} 2>/dev/null ` +
  `| head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/'`;

// A Bedrock-backed config dir has no OAuth login at all -- credentials come from
// AWS, and settings.json carries CLAUDE_CODE_USE_BEDROCK. Judged signed-in by that
// flag, because the .credentials.json test that works for a subscription would call
// a perfectly good Bedrock setup "not signed in" and refuse to let you select it.
const BEDROCK_OF = (dir) =>
  `if grep -q '"CLAUDE_CODE_USE_BEDROCK"' ${dir}/settings.json 2>/dev/null; then ` +
  `r=$(grep -o '"AWS_REGION"[[:space:]]*:[[:space:]]*"[^"]*"' ${dir}/settings.json 2>/dev/null ` +
  `| head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/'); b="bedrock:$r"; else b=""; fi`;

const DISCOVER_SH =
  // The default account, if a config home exists at all.
  'if [ -d "$HOME/.claude" ]; then ' +
  `e=$(${EMAIL_OF('"$HOME/.claude.json"')}); ` +
  '[ -f "$HOME/.claude/.credentials.json" ] && c=yes || c=no; ' +
  `${BEDROCK_OF('"$HOME/.claude"')}; ` +
  'printf \'%s\\t%s\\t%s\\t%s\\n\' "$HOME/.claude" "$e" "$c" "$b"; ' +
  'fi; ' +
  // Alternates, via `find` rather than a glob. A glob that matches nothing is not
  // harmless here: the mac's login shell is zsh, where `nomatch` makes an unmatched
  // pattern a hard error that aborts the command, so the whole probe exits non-zero
  // and even the default account found above is lost. find just prints nothing.
  // Listed even when half-set-up (dir made, login unfinished) so the UI can show
  // them as "not signed in" rather than pretending they do not exist.
  'find "$HOME/.claude-accts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do ' +
  `e=$(${EMAIL_OF('"$d/.claude.json"')}); ` +
  '[ -f "$d/.credentials.json" ] && c=yes || c=no; ' +
  `${BEDROCK_OF('"$d"')}; ` +
  'printf \'%s\\t%s\\t%s\\t%s\\n\' "$d" "$e" "$c" "$b"; ' +
  'done; ' +
  // Always succeed: a missing dir or an unreadable file is a normal answer ("no
  // alternates"), not a failure, and a non-zero exit would throw away the rows
  // already printed.
  ':';

/**
 * @returns {Promise<Array<{dir, email, loggedIn, isDefault, label}>>}
 * Always includes the default account, even when it cannot be read, so the UI can
 * still offer "use the default" rather than showing an empty list.
 */
export async function listAccounts(host) {
  let rows = [];
  try {
    // Belt and braces alongside the trailing `:` -- if the probe ever does exit
    // non-zero, the rows it managed to print are still on err.stdout and are worth
    // more than an empty list.
    let stdout;
    try {
      ({ stdout } = await execOnHost(host, DISCOVER_SH, { timeout: 15000 }));
    } catch (err) {
      if (!err || !err.stdout) throw err;
      stdout = err.stdout;
    }
    rows = String(stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [dir, email, creds, bedrock] = l.split('\t');
        const region = bedrock && bedrock.startsWith('bedrock:') ? bedrock.slice(8) : null;
        const isBedrock = !!(bedrock && bedrock.startsWith('bedrock:'));
        return {
          dir,
          email: email || null,
          kind: isBedrock ? 'bedrock' : 'oauth',
          region: region || null,
          // Bedrock needs no Claude login; AWS supplies the credentials.
          loggedIn: isBedrock || creds === 'yes',
        };
      })
      .filter((r) => r.dir && r.dir.startsWith('/'));
  } catch {
    rows = [];
  }

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.dir)) continue;
    seen.add(r.dir);
    const isDefault = /\/\.claude$/.test(r.dir);
    out.push({
      ...r,
      isDefault,
      // The folder name is what a person picked ("work"); the email is what proves
      // which account it actually is. Show the name, keep the email for the tooltip.
      label: isDefault ? 'Default' : r.dir.split('/').filter(Boolean).pop(),
      // One line saying what this actually is, so the picker reads the same whether
      // the identity is a subscription email or an AWS region.
      detail:
        r.kind === 'bedrock'
          ? `AWS Bedrock${r.region ? ` · ${r.region}` : ''}`
          : r.email || (r.loggedIn ? r.dir : null),
    });
  }
  // Default first, then alphabetical: the common case is at the top of the menu.
  out.sort((a, b) => (a.isDefault === b.isDefault ? a.label.localeCompare(b.label) : a.isDefault ? -1 : 1));
  return out;
}
