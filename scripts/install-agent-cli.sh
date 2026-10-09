#!/usr/bin/env bash
# Install the maestro-task CLI and its token on a host, so agents there can assign
# work to each other. Run from the Maestro checkout:  bash scripts/install-agent-cli.sh [ssh-target]
#
# With no argument it installs locally (oracle). The token is read out of Maestro's
# own database, written 0600, and never echoed.
set -euo pipefail
TARGET="${1:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(sqlite3 "$REPO/data/maestro.db" "select value from settings where key='agent_api_token';")"
[ -n "$TOKEN" ] || { echo "no agent_api_token in the database — start Maestro once first" >&2; exit 1; }

if [ -z "$TARGET" ]; then
  mkdir -p "$HOME/.local/bin" "$HOME/.maestro"
  install -m 0755 "$REPO/scripts/maestro-task" "$HOME/.local/bin/maestro-task"
  umask 077; printf '%s' "$TOKEN" > "$HOME/.maestro/agent-token"
  echo "installed locally: $HOME/.local/bin/maestro-task"
else
  # MAESTRO_URL must point back at the server; a remote host cannot use localhost.
  URL="${MAESTRO_URL:-http://100.72.255.33:7007}"
  ssh "$TARGET" 'mkdir -p ~/.local/bin ~/.maestro && chmod 700 ~/.maestro'
  scp -q "$REPO/scripts/maestro-task" "$TARGET:~/.local/bin/maestro-task"
  ssh "$TARGET" "chmod 755 ~/.local/bin/maestro-task; umask 077; printf '%s' '$TOKEN' > ~/.maestro/agent-token; printf 'export MAESTRO_URL=%s\n' '$URL' > ~/.maestro/env"
  echo "installed on $TARGET (MAESTRO_URL=$URL)"
fi
