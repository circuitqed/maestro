#!/usr/bin/env bash
# Warn before the disk fills, and say WHAT is filling it.
#
# Written after oracle hit 97% with no warning. The causes were not obvious from a
# df: one container's unrotated json log had reached 14 GB, and a nightly 5.6 GB
# SQLite backup was being kept 7 times over. So this does not just report a
# percentage — it names the biggest movers, which is what makes the warning useful
# at 2am rather than something to go and investigate from scratch.
#
#   disk-watch.sh            warn only if past the threshold (what cron runs)
#   disk-watch.sh --report   always print the breakdown

set -uo pipefail

WARN=85          # percent: start mentioning it
CRIT=92          # percent: say so loudly
LOG=/home/projects/maestro/data/disk-watch.log
STATE=/home/projects/maestro/data/disk-watch.state
DB=/home/projects/maestro/data/maestro.db

used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
avail=$(df -h --output=avail / | tail -1 | tr -d ' ')
force=0
[ "${1:-}" = "--report" ] && force=1

breakdown() {
  echo "  disk: ${used}% used, ${avail} free"
  # /var/lib/docker is root-only, and this runs as dave from cron — so ask docker
  # itself rather than the filesystem. (An earlier version used du here and silently
  # printed nothing, which would have made the warning useless exactly when needed.)
  echo "  largest docker volumes:"
  docker system df -v 2>/dev/null \
    | awk '/^VOLUME NAME/{f=1;next} /^$/{f=0} f{print $NF, $1}' \
    | sort -rh | head -3 | awk '{printf "    %-8s %s\n", $1, $2}'
  echo "  docker totals:"
  docker system df 2>/dev/null | awk 'NR>1 {printf "    %-16s %-9s reclaimable %s\n", $1, $4, $5}' | head -4
  echo "  largest home dirs:"
  du -xh -d1 /home 2>/dev/null | sort -rh | sed -n '2,4p' | sed 's/^/    /'
}

if [ "$used" -ge "$WARN" ] || [ "$force" = "1" ]; then
  level="WARN"; [ "$used" -ge "$CRIT" ] && level="CRITICAL"
  {
    echo "$(date -Is) $level disk ${used}% (${avail} free)"
    breakdown
  } | tee -a "$LOG"

  # Surface it where it will actually be noticed, not only in a log nobody opens.
  if [ -f "$DB" ] && [ "$used" -ge "$WARN" ]; then
    last=$(cat "$STATE" 2>/dev/null || echo 0)
    now=$(date +%s)
    # At most one row every 6h, so a disk that sits at 86% does not spam the feed.
    if [ $((now - last)) -gt 21600 ]; then
      sqlite3 "$DB" "INSERT INTO activity_log (event_type, message) VALUES ('disk', 'Disk ${used}% full on oracle — ${avail} free');" 2>/dev/null \
        && echo "$now" > "$STATE"
    fi
  fi
  [ "$used" -ge "$CRIT" ] && exit 2
  exit 1
fi
exit 0
