#!/usr/bin/env bash
# Install, launch and pull the log from a connected, unlocked iPhone.
#   DEVICE=<udid from `xcrun devicectl list devices`> scripts/device.sh install|launch|log [dest]
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEVICE:?set DEVICE to the phone identifier (xcrun devicectl list devices)}"
BUNDLE_ID=io.shielded.mothmobilespike
case "${1:-}" in
  install) xcrun devicectl device install app --device "$DEVICE" build/MothSpike.app ;;
  launch) xcrun devicectl device process launch --terminate-existing --device "$DEVICE" "$BUNDLE_ID" ;;
  log)
    dest=${2:-build/spike-log.txt}
    xcrun devicectl device copy from --device "$DEVICE" --domain-type appDataContainer \
      --domain-identifier "$BUNDLE_ID" --source Documents/spike-log.txt --destination "$dest" >/dev/null
    echo "$dest" ;;
  *) echo "usage: DEVICE=<udid> $0 install|launch|log [dest]" >&2; exit 2 ;;
esac
