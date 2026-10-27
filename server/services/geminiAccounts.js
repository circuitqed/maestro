/**
 * Which Antigravity (agy) accounts are signed in on a host.
 *
 * The Claude analogue is accounts.js, and the shape is deliberately the same so one
 * picker can drive both. What differs is the unit of isolation: Claude relocates its
 * config with CLAUDE_CONFIG_DIR, but agy has no such knob -- one credential at
 * $HOME/.gemini/antigravity-cli/antigravity-oauth-token, no --config-dir, no
 * --account, no `login` subcommand. Tested on 1.4.7: ANTIGRAVITY_CONFIG_REL_DIR
 * relocates nothing and AGY_ACCOUNT is ignored. So an alternate account is a whole
 * alternate HOME (see scripts/add-gemini-account.sh), and that is what we discover.
 *
 * Convention: the default account is the real home; alternates are ~/.agy-accts/<name>.
 *
 * Identity comes from the token file's `id_token_email`, which is the one piece of
 * it that is not a secret. `auth_method` distinguishes a consumer login from a
 * Workspace/EDU one, which is exactly the distinction worth seeing in a picker --
 * it is the difference between a personal quota and an institutional one.
 *
 * Discovered, not configured: a hand-maintained list drifts, and the failure mode is
 * pointing an agent at an account nobody is signed in to.
 */
import { execOnHost } from './hosts.js';

// Read the identity out of a token file WITHOUT reading the token. python3 is used
// rather than grep because the file is JSON and the email is a value, not a line;
// a grep would also happily match the token if the format ever changes.
const IDENTITY_OF = (tokenPath) =>
  `python3 -c 'import json,sys\n` +
  `try:\n` +
  `    d=json.load(open(sys.argv[1]))\n` +
  `    print((d.get("id_token_email") or "") + "\\t" + (d.get("auth_method") or ""))\n` +
  `except Exception:\n` +
  `    print("\\t")' ${tokenPath} 2>/dev/null || printf '\\t'`;

// Emits: dir \t email \t auth_method \t signedIn
// Always exits 0 -- a missing dir is a normal answer ("no alternates"), and a
// non-zero exit would discard the rows already printed.
const DISCOVER_SH =
  // The default account: the real home, if agy has ever run there.
  'if [ -d "$HOME/.gemini/antigravity-cli" ] || [ -x "$HOME/.local/bin/agy" ]; then ' +
  't="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; ' +
  '[ -f "$t" ] && c=yes || c=no; ' +
  `i=$(${IDENTITY_OF('"$t"')}); ` +
  'printf \'%s\\t%s\\t%s\\n\' "$HOME" "$i" "$c"; ' +
  'fi; ' +
  // Alternates. `find` rather than a glob: an unmatched glob is a hard error under
  // zsh (the mac's login shell), which would abort the whole probe and lose the
  // default account found above. find just prints nothing.
  'find "$HOME/.agy-accts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do ' +
  't="$d/.gemini/antigravity-cli/antigravity-oauth-token"; ' +
  '[ -f "$t" ] && c=yes || c=no; ' +
  `i=$(${IDENTITY_OF('"$t"')}); ` +
  'printf \'%s\\t%s\\t%s\\n\' "$d" "$i" "$c"; ' +
  'done; ' +
  ':';

/**
 * @param {object|null} host  null => local
 * @returns {Promise<Array<{dir, email, authMethod, loggedIn, usable, isDefault, label, detail}>>}
 *   Same field names as listAccounts() so the picker can be provider-agnostic.
 */
export async function listGeminiAccounts(host) {
  let stdout = '';
  try {
    ({ stdout } = await execOnHost(host, DISCOVER_SH, { timeout: 15000 }));
  } catch (err) {
    // Belt and braces: if the probe did exit non-zero, rows it managed to print are
    // on err.stdout and are worth more than an empty list.
    if (!err || !err.stdout) return [];
    stdout = err.stdout;
  }

  const rows = String(stdout || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [dir, email, authMethod, signedIn] = l.split('\t');
      return {
        dir: (dir || '').trim(),
        email: (email || '').trim() || null,
        authMethod: (authMethod || '').trim() || null,
        loggedIn: signedIn === 'yes',
      };
    })
    .filter((r) => r.dir.startsWith('/'));

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.dir)) continue;
    seen.add(r.dir);
    // The default account is the real home; alternates live under .agy-accts/.
    const isDefault = !/\/\.agy-accts\/[^/]+$/.test(r.dir);
    out.push({
      ...r,
      isDefault,
      // There is no token-expiry field to check here, unlike Claude's
      // credentials.json, so "usable" is simply "a credential exists". agy refreshes
      // silently and tells us nothing we could read without spending a call.
      usable: r.loggedIn,
      kind: 'oauth',
      label: isDefault ? 'Default' : r.dir.split('/').filter(Boolean).pop(),
      detail: r.loggedIn
        ? [r.email || r.dir, r.authMethod && r.authMethod !== 'consumer' ? r.authMethod : null]
            .filter(Boolean)
            .join(' · ')
        : 'not signed in — run add-gemini-account.sh, then `agy` once',
    });
  }
  // Default first, then alphabetical: the common case at the top of the menu.
  out.sort((a, b) => (a.isDefault === b.isDefault ? a.label.localeCompare(b.label) : a.isDefault ? -1 : 1));
  return out;
}
