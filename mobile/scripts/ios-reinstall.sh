#!/bin/bash
# Rebuilds the Release app with a fresh free-team signing profile and installs
# it on the iPhone. Free (Personal Team) profiles expire after 7 days, so this
# needs to run at least weekly; ios-autoinstall.sh does that automatically.
#
#   mobile/scripts/ios-reinstall.sh            # build + install + launch
#   FINTRACK_DEVICE=<udid> ios-reinstall.sh    # a different phone
set -euo pipefail

DEVICE="${FINTRACK_DEVICE:-12E14519-FBF4-5187-A971-89DEFD71C15D}"
TEAM="${FINTRACK_TEAM:-U24U3RGG3D}"
BUNDLE_ID="dev.fintrack.app"
RENEW_DAYS=3

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$MOBILE/ios"
APP="$IOS/build-release/Build/Products/Release-iphoneos/Fintrack.app"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
STATE="$HOME/Library/Application Support/fintrack/ios-install.json"
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { echo "[$(date '+%F %T')] $*"; }
expiry_of() { security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null; }
epoch() { date -juf '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; }

# Xcode reuses a cached profile until it expires; drop ours early so the build gets a new 7-day one.
if [ -f "$APP/embedded.mobileprovision" ]; then
  uuid=$(security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract UUID raw -o - -)
  exp=$(expiry_of "$APP/embedded.mobileprovision")
  if [ -n "$exp" ] && [ $(( $(epoch "$exp") - $(date +%s) )) -lt $(( RENEW_DAYS * 86400 )) ]; then
    log "profile $uuid expires $exp; requesting a new one"
    rm -f "$PROFILES/$uuid.mobileprovision"
  fi
fi

log "building Release"
cd "$IOS"
NODE_ENV=production APP_VARIANT=production xcodebuild -workspace Fintrack.xcworkspace -scheme Fintrack -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build-release \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  build > /tmp/fintrack-ios-build.log 2>&1 || { log "build failed, see /tmp/fintrack-ios-build.log"; tail -20 /tmp/fintrack-ios-build.log; exit 1; }

exp=$(expiry_of "$APP/embedded.mobileprovision")
log "built; signing valid until $exp"

log "installing on $DEVICE"
xcrun devicectl device install app --device "$DEVICE" "$APP" > /dev/null
mkdir -p "$(dirname "$STATE")"
printf '{"installed_at":"%s","expires_at":"%s"}\n' "$(date -u +%FT%TZ)" "$exp" > "$STATE"
log "installed"

# Launching fails while the phone is locked; the install itself has already succeeded.
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" > /dev/null 2>&1 && log "launched" || true
