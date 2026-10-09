#!/usr/bin/env bash
# Wire the Stanford AI API Gateway up as a selectable Maestro account.
#
# Run it, paste the key at the silent prompt. The key is never echoed, never put in
# a shell argument (so it stays out of `ps` and shell history), and never leaves
# this host. It lands in one 600 file inside its own Claude config dir.
#
#   bash scripts/add-stanford-api-account.sh [account-name]
#
# Scoped on purpose. ANTHROPIC_AUTH_TOKEN silently outranks a stored subscription
# login, so putting it anywhere global -- a shell rc, ~/.claude/settings.json --
# would quietly move EVERY Claude agent on this host onto metered billing against
# the PTA, with no visible change in the UI. Confining it to one config dir means
# only agents you explicitly switch in the account badge can spend money.
set -uo pipefail

NAME="${1:-stanford-api}"
BASE_URL="https://aiapi-prod.stanford.edu"
# Must be one the key is actually allowed; the model list printed below is the truth.
CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"
DIR="$HOME/.claude-accts/$NAME"

die() { printf '%s\n' "$*" >&2; exit 1; }

printf 'Stanford AI API Gateway key (starts with sk-, input hidden): '
read -rs KEY; echo
[ -n "$KEY" ] || die 'no key entered'
case "$KEY" in
  sk-*) : ;;
  *) die "that does not look like a LiteLLM virtual key — it should start with 'sk-'" ;;
esac

echo "== checking the key against the gateway before storing it =="
MODELS=$(curl -sS --max-time 25 "$BASE_URL/v1/models" -H "Authorization: Bearer $KEY" 2>&1)
if printf '%s' "$MODELS" | grep -q '"error"'; then
  printf '%s' "$MODELS" | python3 -c '
import json,sys
try:
    e=(json.load(sys.stdin).get("error") or {})
    print("  gateway rejected it:", e.get("message","(no message)")[:200])
except Exception:
    print("  gateway rejected it (unparseable response)")
'
  die 'not storing a key the gateway will not accept'
fi
echo "  accepted. models your key may use:"
printf '%s' "$MODELS" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("    (could not parse the model list)"); raise SystemExit
ids=[m.get("id") for m in (d.get("data") or []) if m.get("id")]
for i in sorted(ids): print("   -", i)
print(f"    ({len(ids)} models)")
'

mkdir -p "$DIR" && chmod 700 "$HOME/.claude-accts" "$DIR"

# Written with a restrictive umask so the token is never briefly world-readable.
( umask 077
  KEY="$KEY" BASE_URL="$BASE_URL" python3 - "$DIR/settings.json" <<'PY'
import json, os, sys
path = sys.argv[1]
cfg = {}
if os.path.exists(path):
    try: cfg = json.load(open(path))
    except Exception: cfg = {}
env = cfg.setdefault('env', {})
env['ANTHROPIC_BASE_URL'] = os.environ['BASE_URL']
env['ANTHROPIC_AUTH_TOKEN'] = os.environ['KEY']
json.dump(cfg, open(path, 'w'), indent=2)
PY
)
chmod 600 "$DIR/settings.json"
unset KEY

# --- Codex ------------------------------------------------------------------
# The same key also works for the gateway's OpenAI-shaped routes, so set up a
# Codex config home alongside. CODEX_HOME is Codex's CLAUDE_CONFIG_DIR: it
# relocates config.toml, which is where a custom model_provider lives. The key
# goes in its own 0600 file because Codex reads it from an env var (env_key),
# and Maestro's launch command loads that file at start rather than splicing the
# secret into the command line.
CDIR="$HOME/.codex-accts/$NAME"
mkdir -p "$CDIR" && chmod 700 "$HOME/.codex-accts" "$CDIR"
( umask 077; printf '%s' "$KEY" > "$CDIR/key" )
chmod 600 "$CDIR/key"
( umask 077; cat > "$CDIR/config.toml" <<TOML
# Codex pointed at the Stanford AI API Gateway (LiteLLM).
# Selected per agent via CODEX_HOME, so no other Codex agent is affected.
model = "$CODEX_MODEL"
model_provider = "stanford"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.stanford]
name = "Stanford AI API Gateway"
base_url = "$BASE_URL/v1"
env_key = "STANFORD_API_KEY"
wire_api = "responses"
TOML
)
chmod 600 "$CDIR/config.toml"

echo "== stored =="
echo "  claude dir : $DIR  ($(stat -c '%a' "$DIR"))"
echo "  codex home : $CDIR  ($(stat -c '%a' "$CDIR"))  model=$CODEX_MODEL"
echo "  settings   : $DIR/settings.json  ($(stat -c '%a' "$DIR/settings.json"))"
echo "  base url   : $BASE_URL"
echo
echo "It will appear in the account badge as '$NAME'. No agent uses it until you"
echo "pick it there and restart that agent. Everything else stays on subscription."
