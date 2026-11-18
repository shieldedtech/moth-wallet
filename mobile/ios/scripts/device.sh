#!/usr/bin/env bash
# Build, install and launch Moth on a connected, unlocked iPhone.
#   TEAM_ID=<Apple developer team id> DEVICE=<udid from `xcrun devicectl list devices`> scripts/device.sh build|install|launch
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEVICE:?set DEVICE to the phone identifier (xcrun devicectl list devices)}"
BUNDLE_ID=bob.shielded.moth
APP=build/DerivedData/Build/Products/Debug-iphoneos/Moth.app
case "${1:-}" in
  build)
    : "${TEAM_ID:?set TEAM_ID to your Apple developer team id}"
    xcodebuild -project Moth.xcodeproj -scheme Moth -configuration Debug -destination "id=$DEVICE" \
      -derivedDataPath build/DerivedData -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" build ;;
  install) xcrun devicectl device install app --device "$DEVICE" "$APP" ;;
  launch) xcrun devicectl device process launch --terminate-existing --device "$DEVICE" "$BUNDLE_ID" ;;
  *) echo "usage: TEAM_ID=… DEVICE=<udid> $0 build|install|launch" >&2; exit 2 ;;
esac
