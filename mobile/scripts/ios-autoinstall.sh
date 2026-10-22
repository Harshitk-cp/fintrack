#!/bin/bash
# Run by launchd every 20 minutes (see ios-autoinstall.plist). When the iPhone
# is reachable on the same Wi-Fi and the installed app's signing expires within
# 3 days (or it was never installed by this script), runs ios-reinstall.sh.
set -uo pipefail

DEVICE="${FINTRACK_DEVICE:-12E14519-FBF4-5187-A971-89DEFD71C15D}"
RENEW_DAYS=3
STATE="$HOME/Library/Application Support/fintrack/ios-install.json"
LOCK="/tmp/fintrack-ios-autoinstall.lock"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

log() { echo "[$(date '+%F %T')] $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Fintrack\"" > /dev/null 2>&1 || true; }

if [ -f "$STATE" ]; then
  exp=$(plutil -extract expires_at raw -o - "$STATE" 2>/dev/null || true)
  left=$(( $(date -juf '%Y-%m-%dT%H:%M:%SZ' "$exp" +%s 2>/dev/null || echo 0) - $(date +%s) ))
  [ "$left" -gt $(( RENEW_DAYS * 86400 )) ] && exit 0   # still fresh: nothing to do, stay quiet
fi

json=$(mktemp)
xcrun devicectl list devices --json-output "$json" > /dev/null 2>&1
tunnel=$(/usr/bin/python3 -c "import json,sys; d=json.load(open(sys.argv[1]))['result']['devices']; print(next((x['connectionProperties'].get('tunnelState','') for x in d if sys.argv[2] in (x['identifier'], x['hardwareProperties'].get('udid'))), ''))" "$json" "$DEVICE" 2>/dev/null)
rm -f "$json"
# "unavailable" means the phone isn't on this network (or is asleep); try again next run.
[ -z "$tunnel" ] || [ "$tunnel" = "unavailable" ] && exit 0

mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

log "iPhone reachable ($tunnel) and signing is due; reinstalling"
if "$HERE/ios-reinstall.sh"; then
  notify "Reinstalled on your iPhone. Good for another 7 days."
else
  notify "Couldn't reinstall on your iPhone. See ~/Library/Logs/fintrack-ios.log"
fi
