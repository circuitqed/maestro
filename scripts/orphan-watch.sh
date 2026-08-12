#!/bin/sh
# Flag long-running, CPU-pegged processes owned by this user.
#
# Why: an agent that starts a watch-mode process (vitest, pytest --watch, a dev
# server) can leave it running when its session dies. One orphaned vitest sat at
# 101% CPU for SEVEN DAYS on this 4-core box before anyone noticed — a quarter of
# the machine, silently. Nothing else notices, because the process looks healthy.
#
# `ps` %cpu is a LIFETIME AVERAGE, so a process averaging >THRESHOLD over hours is
# genuinely pegged, not merely busy right now. That is the signal we want.
#
# Reports only — never kills. Judgement about "is this legitimate work?" stays human.
CPU_MIN=${ORPHAN_CPU_MIN:-50}     # percent, lifetime average
AGE_MIN=${ORPHAN_AGE_MIN:-7200}   # seconds (2h)
LOG=${ORPHAN_LOG:-$HOME/.local/state/orphan-watch.log}
LATEST=${ORPHAN_LATEST:-$HOME/.local/state/orphan-watch.latest}

hits=$(ps -eo user=,pid=,ppid=,pcpu=,etimes=,args= 2>/dev/null | awk \
  -v u="$(id -un)" -v c="$CPU_MIN" -v a="$AGE_MIN" '
  $1==u && ($4+0)>c && ($5+0)>a {
    cmd=""; for (i=6; i<=NF && i<26; i++) cmd=cmd" "$i
    printf "  pid=%s ppid=%s cpu=%.0f%% age=%.1fh%s\n", $2, $3, $4, $5/3600, cmd
  }')

ts=$(date '+%Y-%m-%d %H:%M:%S')
if [ -n "$hits" ]; then
  { echo "[$ts] CPU-pegged process(es) over ${CPU_MIN}% for >$((AGE_MIN/3600))h:"; echo "$hits"; } | tee -a "$LOG" > "$LATEST"
  exit 1   # non-zero so cron/MAILTO surfaces it
else
  echo "[$ts] clear" >> "$LOG"
  : > "$LATEST"
fi

# Keep the log bounded (a "clear" line every 30min would otherwise grow forever).
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
  tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
