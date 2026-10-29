#!/usr/bin/env bash
# Copies the engine page and proving material into the app bundle, keeping their directory
# layout. Run by the "Bundle engine" phase of Moth.xcodeproj.
#
# Proving material is the built-in wallet circuits (zswap + dust; version dir 9 is ledger
# 8.1.x) and SRS up to 2^17, from MIDNIGHT_PP. Anything missing is downloaded by the in-app
# prover on first use, so a build without a local cache still works, just slower at first.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
PP=${MIDNIGHT_PP:-$HOME/.cache/midnight/zk-params}

[ -f engine/dist/index.html ] || { echo "error: run mobile/ios/scripts/build-engine.sh first" >&2; exit 1; }
rsync -a --delete engine/dist/ "$DEST/engine/"

mkdir -p "$DEST/params"
if [ -d "$PP/zswap/9" ] && [ -d "$PP/dust/9" ]; then
  mkdir -p "$DEST/params/zswap" "$DEST/params/dust"
  rsync -a "$PP/zswap/9" "$DEST/params/zswap/" && rsync -a "$PP/dust/9" "$DEST/params/dust/"
  # `if`, not `[ … ] && cp`: a missing last file would leave the loop with a non-zero status
  # and fail the build under `set -e`, though a partial cache is fine (see above).
  for k in 10 11 12 13 14 15 16 17; do
    if [ -f "$PP/bls_midnight_2p$k" ]; then cp "$PP/bls_midnight_2p$k" "$DEST/params/"; fi
  done
else
  echo "warning: no zk params at $PP; Moth will download them on first proof"
fi
