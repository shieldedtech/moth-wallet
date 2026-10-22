#!/usr/bin/env bash
# Copies the engine page built by mobile/ios/scripts/build-engine.sh into the app's assets.
# The app extracts it to its files directory on first launch and serves it from there.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../ios/engine/dist
[ -f "$SRC/index.html" ] || { echo "error: run mobile/ios/scripts/build-engine.sh first" >&2; exit 1; }
mkdir -p app/src/main/assets
rsync -a --delete "$SRC/" app/src/main/assets/engine/
du -sh app/src/main/assets/engine
