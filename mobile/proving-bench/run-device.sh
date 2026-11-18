#!/usr/bin/env bash
# Installs and launches the app, then (on "pull") copies results back.
#   DEVICE=<udid from `xcrun devicectl list devices`> ./run-device.sh install|launch|pull [results-subdir]
set -euo pipefail
cd "$(dirname "$0")"
: "${DEVICE:?set DEVICE to the phone identifier (xcrun devicectl list devices)}"
BID=io.shielded.mnprovebench
case "${1:-}" in
  install) xcrun devicectl device install app --device "$DEVICE" build/MNProveBench.app ;;
  launch)  xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BID" ;;
  pull)
    out=results/${2:-run-$(date +%Y%m%d-%H%M%S)}; mkdir -p "$out"
    for f in events.jsonl ksweep.jsonl thermal.jsonl; do
      xcrun devicectl device copy from --device "$DEVICE" --domain-type appDataContainer --domain-identifier "$BID" \
        --source "Documents/$f" --destination "$out/$f" >/dev/null || echo "missing $f"
    done
    python3 summarize_ksweep.py "$out/ksweep.jsonl" ;;
  *) echo "usage: DEVICE=<udid> $0 install|launch|pull [dir]"; exit 1 ;;
esac
