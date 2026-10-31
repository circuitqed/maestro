/**
 * Adding a gateway (API-token) account to a host.
 *
 * The OAuth card next door signs in a SUBSCRIPTION. This is the other kind of
 * identity: an Anthropic-compatible endpoint plus a bearer token — Stanford's
 * LiteLLM gateway, or any proxy. There is no interactive flow to drive, so it is a
 * form rather than a card walking a TUI.
 *
 * HOW THE TOKEN IS HANDLED, which is the only interesting thing here:
 *
 * - It never appears in a command line. Everything that needs it is delivered by
 *   piping a generated script into `bash -s` over ssh, so the secret travels on
 *   stdin and is never in argv — not on this host, not on the target. `ps` on either
 *   machine shows `bash -s` and nothing else.
 * - It is never written to the database, never logged, and never echoed back in a
 *   response. The only copies that persist are the two files it is meant to live in.
 * - Those are written under `umask 077`, so there is no window where they are
 *   world-readable, and chmod 600 afterwards regardless.
 * - The probe uses `curl --config`, reading the Authorization header from a file, so
 *   even the validation step keeps it out of argv.
 *
 * WHY IT IS VALIDATED FIRST, AND WHY THAT IS FREE: storing a token the gateway will
 * not accept produces an account that looks fine in the picker and fails only when an
 * agent runs on it. `/v1/models` is an allowed route on the gateway and is NOT billed
 * (unlike the budget probe in gatewayUsage.js, which needs a real completion to get
 * the headers), so the check costs nothing and also returns the model list the key is
 * permitted to use — worth showing, since this key refuses haiku.
 *
 * It is validated FROM THE TARGET HOST rather than from here, because "can this key
 * reach the gateway" is a question about that machine's network, not Maestro's.
 */
import { execOnHost, shellQuote, isRemote } from './hosts.js';
import { spawn } from 'child_process';
import { sshBaseArgs, remoteWrap } from './hosts.js';
import { listAccounts } from './accounts.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,30}$/;
// Keep the endpoint to characters that cannot do anything surprising inside the
// generated script, and require TLS: the token is sent as a bearer header.
const URL_RE = /^https:\/\/[A-Za-z0-9._~-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateApiKeyInput({ name, baseUrl, key, codexModel }) {
  if (!NAME_RE.test(String(name || ''))) {
    return 'Account name must be lowercase letters, numbers, . _ or - (max 31)';
  }
  if (!URL_RE.test(String(baseUrl || ''))) {
    return 'Base URL must be an https:// endpoint';
  }
  const k = String(key || '');
  if (!k.trim()) return 'A token is required';
  // Newlines would let a value escape the quoted heredoc it is delivered in. No real
  // token or URL contains one, so this is a hard reject rather than an escape attempt.
  if (/[\r\n]/.test(k) || /[\r\n]/.test(String(baseUrl))) {
    return 'Token and base URL must not contain line breaks';
  }
  if (codexModel && !MODEL_RE.test(String(codexModel))) return 'Invalid Codex model name';
  return null;
}

/** Run a generated script on the host with its text on stdin, never in argv. */
function runScriptOnHost(host, script) {
  return new Promise((resolve, reject) => {
    const args = isRemote(host)
      ? [...sshBaseArgs(host), host.ssh_target, remoteWrap(host, 'bash -s')]
      : null;
    const child = args
      ? spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => { /* EPIPE if the shell dies first */ });
    child.stdin.end(script);
  });
}

/**
 * Whatever `<dir>/settings.json` already holds, so an existing account's other
 * settings survive. Read separately, and without the token in play, so the merge can
 * happen here in JS rather than needing python or jq on the far end — the mac mini
 * does not reliably have python3, and this has to work fleet-wide.
 */
async function existingSettings(host, name) {
  try {
    const { stdout } = await execOnHost(
      host,
      `cat "$HOME/.claude-accts/${name}/settings.json" 2>/dev/null || true`,
      { timeout: 15000 }
    );
    const txt = String(stdout || '').trim();
    if (!txt) return {};
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt or unreadable file must not be silently flattened.
    return null;
  }
}

/**
 * Validate the token against the endpoint, and on success write both the Claude
 * config dir and the matching Codex home — the same pair
 * scripts/add-stanford-api-account.sh produces, so an account added here is
 * indistinguishable from one added there. The key works for the gateway's
 * OpenAI-shaped routes too, and an account that only half-exists would fail
 * confusingly for Codex agents later.
 */
export async function addApiKeyAccount(host, { name, baseUrl, key, codexModel = 'gpt-6-astra' }) {
  const bad = validateApiKeyInput({ name, baseUrl, key, codexModel });
  if (bad) throw new Error(bad);

  const prior = await existingSettings(host, name);
  if (prior === null) {
    throw new Error(`${name}/settings.json exists but could not be parsed — fix or remove it first`);
  }
  const merged = {
    ...prior,
    env: { ...(prior.env || {}), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key },
  };

  // Quoted delimiters throughout: nothing in these heredocs is expanded by the
  // remote shell, so the token is written exactly as given and cannot be re-parsed.
  const script = `
set -u
umask 077
BASE=${shellQuote(baseUrl)}
DIR="$HOME/.claude-accts/${name}"
CDIR="$HOME/.codex-accts/${name}"
mkdir -p "$DIR" "$CDIR" || { echo "MAESTRO_ERR mkdir failed"; exit 1; }
chmod 700 "$HOME/.claude-accts" "$HOME/.codex-accts" "$DIR" "$CDIR" 2>/dev/null

# --- validate before storing anything -------------------------------------
# curl --config keeps the Authorization header out of argv.
CONF="$DIR/.probe.$$"
cat > "$CONF" <<'MAESTRO_CURL_CONF'
header = "Authorization: Bearer ${key}"
silent
show-error
max-time = 25
MAESTRO_CURL_CONF
OUT=$(curl --config "$CONF" "$BASE/v1/models" 2>&1)
rm -f "$CONF"

case "$OUT" in
  *'"error"'*|'') echo "MAESTRO_REJECTED"; printf '%s\\n' "$OUT" | head -c 600; exit 0 ;;
esac

# --- store ----------------------------------------------------------------
cat > "$DIR/settings.json" <<'MAESTRO_SETTINGS'
${JSON.stringify(merged, null, 2)}
MAESTRO_SETTINGS
chmod 600 "$DIR/settings.json"

cat > "$CDIR/key" <<'MAESTRO_KEY'
${key}
MAESTRO_KEY
# Codex reads the key from an env var; the file must hold no trailing newline.
printf '%s' "$(cat "$CDIR/key")" > "$CDIR/key.tmp" && mv "$CDIR/key.tmp" "$CDIR/key"
chmod 600 "$CDIR/key"

cat > "$CDIR/config.toml" <<'MAESTRO_TOML'
# Codex pointed at an Anthropic/OpenAI-compatible gateway.
# Selected per agent via CODEX_HOME, so no other Codex agent is affected.
model = "${codexModel}"
model_provider = "gateway"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.gateway]
name = "API Gateway"
base_url = "${baseUrl}/v1"
env_key = "STANFORD_API_KEY"
wire_api = "responses"
MAESTRO_TOML
chmod 600 "$CDIR/config.toml"

echo "MAESTRO_OK"
printf '%s\\n' "$OUT" | tr ',' '\\n' | grep -o '"id":"[^"]*"' | sed 's/.*:"//;s/"$//' | sort -u
`;

  const { code, stdout, stderr } = await runScriptOnHost(host, script);
  const out = String(stdout || '');

  if (out.includes('MAESTRO_REJECTED')) {
    const detail = out.split('MAESTRO_REJECTED')[1] || '';
    const m = /"message"\s*:\s*"([^"]{0,200})"/.exec(detail);
    throw new Error(`The gateway rejected that token${m ? `: ${m[1]}` : ''}. Nothing was stored.`);
  }
  if (!out.includes('MAESTRO_OK')) {
    const why = out.replace(/MAESTRO_\w+/g, '').trim() || String(stderr || '').trim() || `exit ${code}`;
    throw new Error(`Could not store the account: ${why.slice(0, 300)}`);
  }

  const models = out
    .split('MAESTRO_OK')[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^[A-Za-z0-9._-]+$/.test(l));

  // Report the account as the picker will see it, rather than asserting success.
  const accounts = await listAccounts(host).catch(() => []);
  const acct = accounts.find((a) => a.dir.endsWith(`/.claude-accts/${name}`)) || null;

  return {
    ok: true,
    name,
    models,
    dir: acct ? acct.dir : null,
    detail: acct ? acct.detail : null,
    usable: !!(acct && acct.usable),
  };
}
