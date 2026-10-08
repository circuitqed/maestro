#!/usr/bin/env bash
# Memory watchdog for the Mac mini (16 GB, M4).
#
# Why this exists: the mini does not crash randomly, it runs itself out of
# memory. Both kernel panics on record have the same shape --
#
#     panic: watchdog timeout: no checkins from watchdogd in 9x seconds
#     free memory 14 MB, compressor 7.7 GB of 16 GB, ~20M compressions
#
# -- i.e. the VM compressor saturates, the machine thrashes so hard that even
# watchdogd cannot be scheduled for 90 seconds, and the kernel force-resets it.
# By the time that happens nothing can be logged, which is why the cause stayed
# invisible: the panic stackshot records process NAMES but not arguments, so
# "13 zsh shells holding 171 GB between them" was as far as forensics could get.
#
# So this does two jobs, in this order:
#
#   1. RECORD. One line a minute of free/compressor/swap, and when it goes bad a
#      full `ps` snapshot WITH ARGUMENTS. That is the piece the panic log cannot
#      give us, and it is what will finally name the thing that spawns the
#      runaway shells.
#   2. INTERVENE. Kill orphaned shells that have grown past any legitimate size,
#      so the machine never reaches the stall. Deliberately narrow -- see reap().
#
# Install with --install (no sudo; it is a user LaunchAgent).

set -uo pipefail

LOGDIR="$HOME/Library/Logs/maestro"
LOG="$LOGDIR/memwatch.log"
SNAPDIR="$LOGDIR/memwatch-snapshots"
PLIST="$HOME/Library/LaunchAgents/com.maestro.memwatch.plist"
LABEL="com.maestro.memwatch"
SELF="$HOME/.local/bin/mac-mini-memwatch.sh"

# Thresholds, set from the two panics rather than guessed. At death: compressor
# was 48% of RAM and free was 14 MB. Critical fires well before that so there is
# still enough headroom to run ps and write a file -- past the stall, nothing runs.
#
# Free memory is deliberately NOT a trigger on its own: macOS keeps free pages
# near zero by design and this machine idles at ~80 MB free, so a free-based
# threshold fires every minute on a perfectly healthy box. It only counts as
# corroboration once the compressor is also filling.
# Overridable from the environment purely so the critical path (snapshot + reap)
# can be exercised on demand instead of only during a real emergency.
COMP_WARN_PCT=${COMP_WARN_PCT:-30}
COMP_CRIT_PCT=${COMP_CRIT_PCT:-42}
FREE_CRIT_MB=${FREE_CRIT_MB:-30}
FREE_CRIT_COMP_PCT=${FREE_CRIT_COMP_PCT:-30}
SWAP_CRIT_MB=${SWAP_CRIT_MB:-6000}
# A shell this big is broken by definition; the panic ones were 11-24 GB. High
# enough that no legitimate login shell or launchd job script is ever a candidate.
REAP_SHELL_MB=${REAP_SHELL_MB:-2048}

mkdir -p "$LOGDIR" "$SNAPDIR"

now() { date "+%Y-%m-%dT%H:%M:%S%z"; }

read_mem() {
  local page ram
  page=$(sysctl -n hw.pagesize)
  ram=$(sysctl -n hw.memsize)
  RAM_MB=$(( ram / 1048576 ))
  # vm_stat prints "Pages free:   12345." -- strip spaces and the trailing dot.
  eval "$(vm_stat | awk -F: '
    /Pages free/              { gsub(/[ .]/,"",$2); print "P_FREE="  $2 }
    /Pages active/            { gsub(/[ .]/,"",$2); print "P_ACTIVE="$2 }
    /Pages inactive/          { gsub(/[ .]/,"",$2); print "P_INACT=" $2 }
    /Pages wired down/        { gsub(/[ .]/,"",$2); print "P_WIRED=" $2 }
    /occupied by compressor/  { gsub(/[ .]/,"",$2); print "P_COMP="  $2 }
  ')"
  FREE_MB=$(( ${P_FREE:-0}   * page / 1048576 ))
  COMP_MB=$(( ${P_COMP:-0}   * page / 1048576 ))
  WIRED_MB=$(( ${P_WIRED:-0} * page / 1048576 ))
  ACTIVE_MB=$(( ${P_ACTIVE:-0} * page / 1048576 ))
  COMP_PCT=$(( COMP_MB * 100 / RAM_MB ))
  # "total = 1024.00M  used = 2.88M  free = 1021.12M"
  SWAP_MB=$(sysctl -n vm.swapusage | awk '{for(i=1;i<=NF;i++) if($i=="used"){gsub(/M/,"",$(i+2)); printf "%d", $(i+2)}}')
  SWAP_MB=${SWAP_MB:-0}
  LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')
}

# A full picture of the machine, with arguments. Written only when things go bad,
# so it stays cheap, and kept as its own file so it survives log rotation.
snapshot() {
  # Two statements, not one `local a=.. b=$a`: `local` expands all its arguments
  # before assigning any of them, so referring to $why on the same line is an
  # unbound variable under `set -u`.
  local why="$1"
  local f="$SNAPDIR/$(date '+%Y%m%d-%H%M%S')-${why}.txt"
  {
    echo "== $(now)  [$why] =="
    echo "free=${FREE_MB}MB compressor=${COMP_MB}MB (${COMP_PCT}% of ${RAM_MB}MB) swap=${SWAP_MB}MB load=${LOAD}"
    echo; echo "-- vm_stat --"; vm_stat
    echo; echo "-- swap --"; sysctl -n vm.swapusage
    echo; echo "-- top 40 by RSS, with arguments --"
    ps -Ao rss,vsz,etime,pid,ppid,user,args -m 2>/dev/null | head -41
    echo; echo "-- every shell alive (the thing that killed it twice) --"
    ps -Ao rss,etime,pid,ppid,user,args 2>/dev/null | awk 'NR==1 || /(^| )(-?)(z|ba)?sh( |$)/'
  } > "$f" 2>&1
  echo "$f"
}

# Narrow on purpose. Only shells, only orphans (ppid 1 -- their real parent died,
# so nothing is coming to clean them up), and only ones past a size no working
# shell reaches. Legitimate launchd job scripts also run with ppid 1, which is
# exactly why size is the discriminator and why the bar is set at 2 GB.
reap() {
  local killed=0 line pid rss args
  while read -r pid rss args; do
    [ -z "${pid:-}" ] && continue
    [ "$rss" -lt $(( REAP_SHELL_MB * 1024 )) ] && continue
    echo "$(now) REAP pid=$pid rss=$((rss/1024))MB args=$args" >> "$LOG"
    kill -9 "$pid" 2>/dev/null && killed=$((killed+1))
  done <<EOF
$(ps -Ao pid,ppid,rss,comm,args 2>/dev/null | awk '$2==1 && $4 ~ /(^|\/)(zsh|bash|sh)$/ {pid=$1; rss=$3; $1=$2=$3=$4=""; print pid, rss, $0}')
EOF
  echo "$killed"
}

run_once() {
  read_mem
  local status="ok"
  [ "$COMP_PCT" -ge "$COMP_WARN_PCT" ] && status="warn"
  if [ "$COMP_PCT" -ge "$COMP_CRIT_PCT" ] || [ "$SWAP_MB" -ge "$SWAP_CRIT_MB" ] \
     || { [ "$FREE_MB" -le "$FREE_CRIT_MB" ] && [ "$COMP_PCT" -ge "$FREE_CRIT_COMP_PCT" ]; }; then
    status="CRIT"
  fi

  printf '%s free=%sMB comp=%sMB(%s%%) swap=%sMB wired=%sMB active=%sMB load=%s %s\n' \
    "$(now)" "$FREE_MB" "$COMP_MB" "$COMP_PCT" "$SWAP_MB" "$WIRED_MB" "$ACTIVE_MB" "$LOAD" "$status" >> "$LOG"

  if [ "$status" = "CRIT" ]; then
    local f n
    f=$(snapshot crit)
    n=$(reap)
    echo "$(now) CRIT snapshot=$f reaped=$n" >> "$LOG"
  fi

  # Keep the log bounded; snapshots are small and worth keeping longer.
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 4000000 ]; then
    tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  find "$SNAPDIR" -type f -mtime +30 -delete 2>/dev/null
}

install_agent() {
  mkdir -p "$(dirname "$SELF")" "$(dirname "$PLIST")"
  cp "$0" "$SELF" && chmod +x "$SELF"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SELF</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/memwatch.out</string>
  <key>StandardErrorPath</key><string>$LOGDIR/memwatch.err</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
  echo "installed: $LABEL (every 60s)  log: $LOG"
}

case "${1:-run}" in
  --install) install_agent ;;
  --status)  read_mem
             echo "RAM=${RAM_MB}MB free=${FREE_MB}MB compressor=${COMP_MB}MB (${COMP_PCT}%) swap=${SWAP_MB}MB load=${LOAD}"
             echo "would-reap candidates (orphan shells >= ${REAP_SHELL_MB}MB):"
             ps -Ao pid,ppid,rss,comm,args 2>/dev/null \
               | awk -v min=$((REAP_SHELL_MB*1024)) '$2==1 && $3>=min && $4 ~ /(^|\/)(zsh|bash|sh)$/ {print "  ", $0}' \
               || true ;;
  *)         run_once ;;
esac
