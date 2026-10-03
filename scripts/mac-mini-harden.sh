#!/usr/bin/env bash
# Diagnose why the Mac mini keeps leaving the tailnet, then stop it happening.
# Run ON the mini (needs sudo):  bash mac-mini-harden.sh
#
# Three different failures look identical from oracle — the host simply stops
# answering — so this reports which one it was before changing anything:
#
#   panic   a kernel panic leaves a .panic report; the mini's history is
#           "userspace watchdog timeout: no successful checkins from WindowServer",
#           which is what the HDMI dummy plug addresses.
#   sleep   macOS slept it. pmset's log names the process that requested it.
#   power   it lost power or was shut down; uptime after the gap gives it away.

set -uo pipefail
say() { printf '\n== %s ==\n' "$*"; }

say "uptime / boot"
uptime
sysctl -n kern.boottime

say "kernel panics (newest 3)"
ls -lt /Library/Logs/DiagnosticReports/*.panic 2>/dev/null | head -3 || echo "none — not a panic"
for f in $(ls -t /Library/Logs/DiagnosticReports/*.panic 2>/dev/null | head -1); do
  echo "--- $(basename "$f") ---"
  grep -iE "panic\(|watchdog|WindowServer|IOKitWaitQuiet" "$f" | head -5
done

say "recent sleep/wake, and WHO asked for it"
pmset -g log 2>/dev/null | grep -iE "Entering Sleep|Wake from|DarkWake|Sleep +Summary" | tail -12

say "current power settings"
pmset -g custom 2>/dev/null | sed -n '1,30p'

say "tailscale"
/Applications/Tailscale.app/Contents/MacOS/Tailscale status 2>/dev/null | head -3 \
  || tailscale status 2>/dev/null | head -3 || echo "tailscale CLI not found"

# ---------------------------------------------------------------- hardening ---
say "applying settings (sudo)"

# Never sleep. A headless agent host has no reason to, and sleeping drops the
# tailnet — which is indistinguishable from a crash when you are 1000 miles away.
sudo pmset -a sleep 0 disablesleep 1 powernap 0 standby 0 autopoweroff 0 || true
# Disks and display may still idle; neither affects reachability.
sudo pmset -a disksleep 0 displaysleep 15 || true
# Come back by itself after a power cut, and after a freeze.
sudo pmset -a autorestart 1 womp 1 || true
sudo systemsetup -setrestartfreeze on 2>/dev/null || true
# Belt and braces: if something still sleeps it, wake every morning so the fleet
# self-heals without anyone walking over.
sudo pmset repeat wakeorpoweron MTWRFSU 07:00 || true

# caffeinate as a system daemon: survives logout, unlike a login item, and holds
# the idle-sleep assertion even if a future macOS update resets pmset.
sudo tee /Library/LaunchDaemons/com.maestro.nosleep.plist >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.maestro.nosleep</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-dimsu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
sudo launchctl bootout system /Library/LaunchDaemons/com.maestro.nosleep.plist 2>/dev/null || true
sudo launchctl bootstrap system /Library/LaunchDaemons/com.maestro.nosleep.plist 2>/dev/null || true

say "result"
pmset -g custom 2>/dev/null | sed -n '1,20p'
echo
echo "caffeinate daemon: $(sudo launchctl list 2>/dev/null | grep -c com.maestro.nosleep) loaded"
echo "restart-on-freeze: $(systemsetup -getrestartfreeze 2>/dev/null)"
echo
echo "Reboot is not required, but a reboot is the real test:"
echo "  the mini should come back on the tailnet with no one logged in."
