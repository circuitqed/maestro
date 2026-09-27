#!/usr/bin/env bash
# Watch for new Claude Code / Codex releases across the fleet and report — or apply —
# what is needed to actually get agents onto them.
#
# The two CLIs behave completely differently, which is why "just restart it" does not
# work uniformly:
#
#   Claude Code  self-updates on launch. The installed symlink moves on its own, but a
#                RUNNING agent keeps the version it started with, so the only action
#                needed is a restart. A restart is safe: Maestro resumes the same
#                session (--resume), so nothing is lost.
#
#   Codex        does NOT self-update. It is a static package installed under
#                ~/.local/share/codex-<version>/, so restarting re-runs the exact same
#                binary forever — the symptom that prompted this script. It has to be
#                downloaded. Restarting IS safe as of the codex-resume change: start
#                passes `codex resume <pinned rollout>`, so the conversation survives —
#                but only when a rollout id is pinned (it is, for any agent whose chat
#                has been opened). Without one it starts fresh, so the report says which.
#
# Usage:
#   cli-watch.sh              report only (what cron runs)
#   cli-watch.sh --apply      install Codex updates, and restart idle CLAUDE agents
#                             that are running an older binary than the one installed
#
# Deliberately NOT done here: upgrading Codex just because a release exists is how the
# chat renderer broke last time (0.153.4 changed the rollout format out from under it).
# Report mode exists so the version bump is a decision, not a surprise.

set -uo pipefail

DB=/home/projects/maestro/data/maestro.db
LOG=/home/projects/maestro/data/cli-watch.log
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

say() { printf '%s\n' "$*"; }
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

# ---------------------------------------------------------------- latest versions ---
codex_latest_tag() {
  curl -fsS -m 30 https://api.github.com/repos/openai/codex/releases/latest 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null
}

# Run a command on a host. Empty ssh_target => local.
on_host() {
  local target="$1" prefix="$2" cmd="$3"
  if [ -z "$target" ]; then
    bash -lc "$cmd" 2>/dev/null
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
      "export PATH=${prefix:-/usr/local/bin:/usr/bin}:\$PATH; $cmd" 2>/dev/null
  fi
}

# codex-package asset matching the host, e.g. x86_64-unknown-linux-musl
codex_asset() {
  local target="$1" prefix="$2"
  local uname_s uname_m
  uname_s=$(on_host "$target" "$prefix" 'uname -s' | tr -d '\r')
  uname_m=$(on_host "$target" "$prefix" 'uname -m' | tr -d '\r')
  case "$uname_s/$uname_m" in
    Linux/x86_64)  echo "codex-package-x86_64-unknown-linux-musl.tar.gz" ;;
    Linux/aarch64) echo "codex-package-aarch64-unknown-linux-musl.tar.gz" ;;
    Darwin/arm64)  echo "codex-package-aarch64-apple-darwin.tar.gz" ;;
    Darwin/x86_64) echo "codex-package-x86_64-apple-darwin.tar.gz" ;;
    *) echo "" ;;
  esac
}

# Install a Codex release into its own versioned dir and repoint the symlink, keeping
# the previous version in place so a bad release can be rolled back by moving one link.
codex_install() {
  local target="$1" prefix="$2" ver="$3" asset="$4"
  local url="https://github.com/openai/codex/releases/download/rust-v${ver}/${asset}"
  on_host "$target" "$prefix" "
    set -e
    d=\$HOME/.local/share/codex-${ver}
    tmp=\$(mktemp -d)
    curl -fsSL -o \$tmp/pkg.tar.gz '${url}'
    mkdir -p \$d
    tar -xzf \$tmp/pkg.tar.gz -C \$d
    rm -rf \$tmp
    test -x \$d/bin/codex
    # /usr/local/bin needs root; fall back to ~/.local/bin, which is on the PATH prefix.
    if sudo -n ln -sfn \$d/bin/codex /usr/local/bin/codex 2>/dev/null; then
      echo linked:/usr/local/bin/codex
    else
      mkdir -p \$HOME/.local/bin
      ln -sfn \$d/bin/codex \$HOME/.local/bin/codex
      echo linked:\$HOME/.local/bin/codex
    fi
    \$d/bin/codex --version
  "
}

# ------------------------------------------------------------------------- report ---
LATEST_TAG=$(codex_latest_tag)
LATEST_VER=${LATEST_TAG#rust-v}
[ -z "$LATEST_VER" ] && { say "could not reach the GitHub releases API — skipping"; log "github unreachable"; exit 0; }

say "codex latest release: ${LATEST_VER}"
say ""

needs_restart=()

while IFS='|' read -r hid hname htarget hprefix; do
  [ -z "$hname" ] && continue

  # Only hosts that actually run agents of each kind matter.
  n_codex=$(sqlite3 "$DB" "select count(*) from agents where (case when json_valid(config) then json_extract(config,'\$.provider') end)='codex' and coalesce(host_id,1)=$hid;" 2>/dev/null)
  n_claude=$(sqlite3 "$DB" "select count(*) from agents where coalesce((case when json_valid(config) then json_extract(config,'\$.provider') end),'claude')='claude' and coalesce(host_id,1)=$hid;" 2>/dev/null)

  probe=$(on_host "$htarget" "$hprefix" 'echo alive')
  if [ "$probe" != "alive" ]; then
    say "$hname: unreachable — skipped"
    log "$hname unreachable"
    continue
  fi

  say "$hname:"

  # ---- Codex: needs an explicit install ----
  if [ "${n_codex:-0}" -gt 0 ]; then
    inst=$(on_host "$htarget" "$hprefix" 'codex --version' | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if [ -z "$inst" ]; then
      say "  codex  : not found on PATH"
    elif [ "$inst" = "$LATEST_VER" ]; then
      say "  codex  : $inst (current)"
    elif [ "$APPLY" = "1" ]; then
      asset=$(codex_asset "$htarget" "$hprefix")
      if [ -z "$asset" ]; then
        say "  codex  : $inst -> $LATEST_VER — no asset for this platform, skipped"
      else
        say "  codex  : $inst -> installing $LATEST_VER ($asset)"
        out=$(codex_install "$htarget" "$hprefix" "$LATEST_VER" "$asset")
        say "           ${out//$'\n'/ | }"
        log "$hname codex $inst -> $LATEST_VER"
      fi
    else
      say "  codex  : $inst -> $LATEST_VER AVAILABLE (run with --apply)"
      log "$hname codex behind: $inst < $LATEST_VER"
    fi
  fi

  # ---- Claude: self-updating; the question is whether live agents are stale ----
  if [ "${n_claude:-0}" -gt 0 ]; then
    inst=$(on_host "$htarget" "$hprefix" 'claude --version' | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    say "  claude : ${inst:-not found} installed"
  fi

  # ---- Which running agents are on an older binary than what is installed? ----
  # Resolved from the pane's own process, not from the symlink: that difference is the
  # whole point (an agent started before an auto-update keeps the old version).
  while IFS='|' read -r aid aname asess aprov astatus; do
    [ -z "$asess" ] && continue
    # Shell agents run no CLI of their own — whatever their pane happens to be running
    # (often a codex/claude invoked by hand) is not a version Maestro manages.
    [ "$aprov" = "shell" ] && continue
    running=$(on_host "$htarget" "$hprefix" "
      pane=\$(tmux list-panes -t '=${asess}:' -F '#{pane_pid}' 2>/dev/null | head -1)
      [ -z \"\$pane\" ] && exit 0
      for pid in \$(pgrep -P \$pane 2>/dev/null); do
        exe=\$(readlink /proc/\$pid/exe 2>/dev/null)
        case \"\$exe\" in *claude*|*codex*) echo \"\$exe\"; break;; esac
      done" | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [ -z "$running" ] && continue
    instv=$(on_host "$htarget" "$hprefix" "$aprov --version" | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [ "$running" = "$instv" ] && continue
    say "  ! $aname ($aprov) running $running, installed $instv"
    needs_restart+=("$hid|$aid|$aname|$aprov|$astatus")
  done < <(sqlite3 "$DB" "select id,name,screen_session,coalesce((case when json_valid(config) then json_extract(config,'\$.provider') end),'claude'),status from agents where coalesce(host_id,1)=$hid and status in ('idle','running','busy');" 2>/dev/null)

  say ""
done < <(sqlite3 "$DB" "select id,name,coalesce(ssh_target,''),coalesce(path_prefix,'') from hosts order by id;" 2>/dev/null)

# ----------------------------------------------------------------------- restarts ---
if [ ${#needs_restart[@]} -eq 0 ]; then
  say "no agent is running a stale binary"
  exit 0
fi

say "agents on a stale binary:"
for row in "${needs_restart[@]}"; do
  IFS='|' read -r hid aid aname aprov astatus <<< "$row"
  if [ "$aprov" = "codex" ]; then
    pinned=$(sqlite3 "$DB" "select coalesce(claude_session_id,'') from agents where id=$aid;" 2>/dev/null)
    if [ -z "$pinned" ]; then
      say "  $aname (codex) — no rollout pinned: a restart would start a FRESH session. Open its chat once first."
      continue
    fi
  fi
  if [ "$astatus" != "idle" ]; then
    say "  $aname — busy, left alone (will be picked up next run)"
    continue
  fi
  if [ "$APPLY" != "1" ]; then
    say "  $aname — idle, would restart (run with --apply)"
    continue
  fi
  say "  $aname — restarting (idle, resumes via --resume)"
  curl -fsS -m 120 -X POST --unix-socket /dev/null >/dev/null 2>&1 || true
  RESTART_OUT=$(cd /home/projects/maestro && node scripts/restart-agent.mjs "$aid" 2>&1 | tail -1)
  say "           $RESTART_OUT"
  log "restarted $aname ($aid): $RESTART_OUT"
done
