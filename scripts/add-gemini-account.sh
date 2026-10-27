#!/usr/bin/env bash
# Create an isolated Antigravity (agy) account home, so one machine can run agents
# under more than one Google account.
#
#   bash scripts/add-gemini-account.sh <name> [ssh-target]
#   bash scripts/add-gemini-account.sh edu dave@garage-wsl
#
# WHY A WHOLE HOME, NOT A CONFIG DIR
#   agy keeps exactly one credential, at
#   $HOME/.gemini/antigravity-cli/antigravity-oauth-token, and offers no
#   --config-dir, no --account and no `login` subcommand. Both plausible env vars
#   were tested against 1.4.7 and neither works: ANTIGRAVITY_CONFIG_REL_DIR
#   relocates nothing, and AGY_ACCOUNT is ignored (a bogus value still
#   authenticated against the existing token). Overriding HOME does work -- agy
#   builds a fresh profile there and correctly reports "Please sign in".
#
#   So this is the Claude multi-account trick one level cruder: ~/.claude-accts/<name>
#   relocates only Claude's config, whereas ~/.agy-accts/<name> relocates EVERYTHING
#   the process sees as home. That is why most of this script is damage control.
#
# WHAT GETS SHARED BACK
#   A bare fake home silently breaks things that have nothing to do with accounts:
#   the agent can no longer push to git (no .ssh, no .gitconfig), and `bash -l`
#   finds no profile so ~/.local/bin leaves PATH and even `agy` stops resolving.
#   PATH is repaired in the launch command (see providers.js); the rest is
#   symlinked here, so there is exactly ONE copy of your keys and git identity.
#
#   Deliberately NOT shared: .gemini (the whole point), .claude and .codex (an
#   agent on this account should not quietly inherit another harness's logins).
set -euo pipefail

NAME="${1:-}"
TARGET="${2:-}"
[ -n "$NAME" ] || { echo "usage: $0 <name> [ssh-target]" >&2; exit 1; }
case "$NAME" in
  *[^a-zA-Z0-9._-]*) echo "name must be [A-Za-z0-9._-] only (it becomes a directory)" >&2; exit 1 ;;
esac

# Runs on the target host. Idempotent: safe to re-run to repair symlinks.
read -r -d '' REMOTE <<'SH' || true
set -euo pipefail
NAME="$1"
REAL="$HOME"
ACCT="$REAL/.agy-accts/$NAME"

mkdir -p "$ACCT/.gemini" "$ACCT/.local"
chmod 700 "$ACCT"

# Shared back, so the account home is not a second copy of your identity.
for item in .ssh .gitconfig .git-credentials .config/git; do
  src="$REAL/$item"
  dst="$ACCT/$item"
  [ -e "$src" ] || continue
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] || [ ! -e "$dst" ]; then
    ln -sfn "$src" "$dst"
  fi
done

# ~/.local/bin is symlinked as well as being forced onto PATH at launch: a human who
# types `agy` in the pane after the agent exits should get the same binary.
if [ -d "$REAL/.local/bin" ] && { [ -L "$ACCT/.local/bin" ] || [ ! -e "$ACCT/.local/bin" ]; }; then
  ln -sfn "$REAL/.local/bin" "$ACCT/.local/bin"
fi

# A minimal profile, because `bash -l` will look here and find nothing otherwise.
cat > "$ACCT/.profile" <<'PROF'
# Antigravity account home (created by maestro add-gemini-account.sh).
# HOME points here so agy keeps a separate login; the binaries are shared.
[ -n "${AGY_REAL_HOME:-}" ] && PATH="$AGY_REAL_HOME/.local/bin:$PATH"
export PATH
PROF

echo "ACCT=$ACCT"
if [ -f "$ACCT/.gemini/antigravity-cli/antigravity-oauth-token" ]; then
  python3 - "$ACCT" <<'PY' 2>/dev/null || echo "  signed in: (could not read identity)"
import json, sys
p = sys.argv[1] + "/.gemini/antigravity-cli/antigravity-oauth-token"
d = json.load(open(p))
print("  signed in as:", d.get("id_token_email", "unknown"), "(" + str(d.get("auth_method", "?")) + ")")
PY
else
  echo "  NOT signed in yet"
fi
SH

run() {
  if [ -z "$TARGET" ]; then bash -c "$REMOTE" _ "$NAME"
  else ssh "$TARGET" "bash -s -- '$NAME'" <<< "$REMOTE"
  fi
}

OUT="$(run)"
printf '%s\n' "$OUT"
ACCT="$(printf '%s' "$OUT" | sed -n 's/^ACCT=//p' | head -1)"

cat <<EOF

Next: sign in to this account. It is interactive (Google OAuth), so it has to be
you, in a shell on ${TARGET:-this host}:

  HOME='$ACCT' PATH="\$HOME/.local/bin:\$PATH" agy

Run it with no arguments — that is agy's sign-in path. Then verify:

  bash scripts/add-gemini-account.sh '$NAME' ${TARGET:+$TARGET}

...which will report the signed-in address instead of "NOT signed in yet".

Finally, point an agent at it: set agyHome='$ACCT' on the agent (the account
picker in the chat/terminal header does this for you).
EOF
