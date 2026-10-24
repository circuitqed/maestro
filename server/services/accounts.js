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
// A gateway-backed dir authenticates with a base URL + token in settings.json
// (Stanford's AI API Gateway, or any Anthropic-compatible proxy). Like Bedrock it
// has no OAuth login, so the .credentials.json test calls a perfectly good setup
// "not signed in" and refuses to let you select it. Only ever reads whether a token
// is PRESENT and what the base URL is -- never the token itself.
const GATEWAY_OF = (dir) =>
  `if grep -qE '\"ANTHROPIC_(AUTH_TOKEN|API_KEY)\"' ${dir}/settings.json 2>/dev/null; then ` +
  `u=$(grep -o '\"ANTHROPIC_BASE_URL\"[[:space:]]*:[[:space:]]*\"[^\"]*\"' ${dir}/settings.json 2>/dev/null ` +
  `| head -1 | sed 's/.*\"\\([^\"]*\\)\"$/\\1/'); g="api:$u"; else g=""; fi`;

// How long the stored OAuth access token is still good for.
//
// `.credentials.json` EXISTING is not the same as the account being usable, and that
// gap bit twice: the work account's token expired on 2026-10-11 and the picker went
// on offering it as signed in, so an agent pinned to it would authenticate against a
// dead token. Access tokens last about an hour and are refreshed only by a Claude
// process actually using the account, so any account nothing has run on lately is
// stale. Reads the expiry only -- never the token.
const EXPIRES_OF = (dir) =>
  `grep -o '"expiresAt"[[:space:]]*:[[:space:]]*[0-9]*' ${dir}/.credentials.json 2>/dev/null ` +
  `| head -1 | grep -o '[0-9]*$'`;

// Whether a refresh token is present -- which decides whether an expired access
// token matters. With one, Claude refreshes on start and the account just works, so
// an expired account must NOT be blocked in the picker: pinning an agent to it is
// precisely how it gets refreshed. Without one it genuinely needs a person to log in.
// Tests presence only; the token is never read.
const HAS_REFRESH_OF = (dir) =>
  `grep -q '"refreshToken"[[:space:]]*:[[:space:]]*"..*"' ${dir}/.credentials.json 2>/dev/null ` +
  `&& echo yes || echo no`;

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
  `${GATEWAY_OF('"$HOME/.claude"')}; ` +
  `x=$(${EXPIRES_OF('"$HOME/.claude"')}); ` +
  `rt=$(${HAS_REFRESH_OF('"$HOME/.claude"')}); ` +
  'printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$HOME/.claude" "$e" "$c" "$b" "$g" "$x" "$rt"; ' +
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
  `${GATEWAY_OF('"$d"')}; ` +
  `x=$(${EXPIRES_OF('"$d"')}); ` +
  `rt=$(${HAS_REFRESH_OF('"$d"')}); ` +
  'printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$d" "$e" "$c" "$b" "$g" "$x" "$rt"; ' +
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
// Host part of a URL, for display. Never shows a token.
function hostOf(u) {
  const m = /^https?:\/\/([^/]+)/.exec(String(u || ''));
  return m ? m[1] : null;
}

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
        const [dir, email, creds, bedrock, gateway, expiresRaw, refreshRaw] = l.split('\t');
        const region = bedrock && bedrock.startsWith('bedrock:') ? bedrock.slice(8) : null;
        const isBedrock = !!(bedrock && bedrock.startsWith('bedrock:'));
        const isGateway = !!(gateway && gateway.startsWith('api:'));
        const baseUrl = isGateway ? gateway.slice(4) : null;
        const expiresAt = Number(expiresRaw) || null;
        const tokenExpired = Boolean(expiresAt && expiresAt < Date.now());
        const hasRefreshToken = refreshRaw === 'yes';
        return {
          dir,
          email: email || null,
          kind: isBedrock ? 'bedrock' : isGateway ? 'api' : 'oauth',
          region: region || null,
          baseUrl: baseUrl || null,
          // Neither Bedrock nor a gateway has a Claude login: AWS or the token
          // supplies the credentials, so .credentials.json is the wrong test.
          loggedIn: isBedrock || isGateway || creds === 'yes',
          // Expiry of the stored access token. `usable` is what a picker should gate
          // on -- a credential file that exists but holds an hours-dead token is not
          // something to offer as ready.
          expiresAt: expiresAt || null,
          tokenExpired,
          hasRefreshToken,
          // Selectable AND expected to work. An expired access token still counts when
          // a refresh token is present -- Claude refreshes it on start.
          usable: isBedrock || isGateway || (creds === 'yes' && (!tokenExpired || hasRefreshToken)),
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
          : r.kind === 'api'
            ? `API · ${hostOf(r.baseUrl) || 'custom endpoint'}`
            : r.tokenExpired
              // Say which it is. A stale token recovers on first use when a refresh
              // token is there; without one it needs a person.
              ? `${r.email || r.dir} · token expired, ${r.hasRefreshToken ? 'refreshes on start' : 'needs login'}`
              : r.email || (r.loggedIn ? r.dir : null),
    });
  }
  // Default first, then alphabetical: the common case is at the top of the menu.
  out.sort((a, b) => (a.isDefault === b.isDefault ? a.label.localeCompare(b.label) : a.isDefault ? -1 : 1));
  return out;
}
