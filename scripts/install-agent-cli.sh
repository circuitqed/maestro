#!/usr/bin/env bash
# Install the Maestro agent CLIs and their token on a host, so agents there can
# assign work to each other and spawn swarms. Run from the Maestro checkout:
#   bash scripts/install-agent-cli.sh [ssh-target]
#
# With no argument it installs locally (oracle). The token is read out of Maestro's
# own database, written 0600, and never echoed.
set -euo pipefail
TARGET="${1:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(sqlite3 "$REPO/data/maestro.db" "select value from settings where key='agent_api_token';")"
[ -n "$TOKEN" ] || { echo "no agent_api_token in the database — start Maestro once first" >&2; exit 1; }

# maestro-worker ships with the rest even though it is not for agents to run: the
# swarm runner invokes it by path on the host, and a host missing it fails one
# worker at a time, silently, after the money is already committed.
TOOLS=(maestro-task maestro-swarm maestro-worker)

if [ -z "$TARGET" ]; then
  mkdir -p "$HOME/.local/bin" "$HOME/.maestro"
  for t in "${TOOLS[@]}"; do install -m 0755 "$REPO/scripts/$t" "$HOME/.local/bin/$t"; done
  umask 077; printf '%s' "$TOKEN" > "$HOME/.maestro/agent-token"
  echo "installed locally in $HOME/.local/bin: ${TOOLS[*]}"
else
  # MAESTRO_URL must point back at the server; a remote host cannot use localhost.
  URL="${MAESTRO_URL:-http://100.72.255.33:7007}"
  REMOTE_PATHS=""
  for t in "${TOOLS[@]}"; do REMOTE_PATHS="$REMOTE_PATHS ~/.local/bin/$t"; done
  ssh "$TARGET" 'mkdir -p ~/.local/bin ~/.maestro && chmod 700 ~/.maestro'
  for t in "${TOOLS[@]}"; do scp -q "$REPO/scripts/$t" "$TARGET:~/.local/bin/$t"; done
  ssh "$TARGET" "chmod 755$REMOTE_PATHS; umask 077; printf '%s' '$TOKEN' > ~/.maestro/agent-token; printf 'export MAESTRO_URL=%s\n' '$URL' > ~/.maestro/env"
  echo "installed on $TARGET (MAESTRO_URL=$URL): ${TOOLS[*]}"
fi
