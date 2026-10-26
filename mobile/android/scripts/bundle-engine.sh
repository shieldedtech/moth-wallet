#!/usr/bin/env bash
# Copies the engine page built by mobile/ios/scripts/build-engine.sh into the app's assets.
# The app extracts it to its files directory on first launch and serves it from there.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../ios/engine/dist
[ -f "$SRC/index.html" ] || { echo "error: run mobile/ios/scripts/build-engine.sh first" >&2; exit 1; }
mkdir -p app/src/main/assets
rsync -a --delete "$SRC/" app/src/main/assets/engine/
# Android's asset packager gunzips any asset named *.gz and drops the extension, so the
# engine's pre-seed snapshots (preseed/<network>/*.dat.gz) would arrive as *.dat and 404.
# They travel as *.gz.asset; Bundled.kt restores the name when it extracts them.
find app/src/main/assets/engine -name '*.gz' -exec sh -c 'mv "$1" "$1.asset"' _ {} \;
du -sh app/src/main/assets/engine
