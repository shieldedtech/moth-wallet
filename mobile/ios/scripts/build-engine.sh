#!/usr/bin/env bash
# Builds the engine page (engine/dist): moth's wallet worker plus the Swift bridge, with the
# pre-seed snapshots the extension bundles. Run after `yarn install && yarn build` at the
# repo root, and again whenever moth's packages change.
#
# LEDGER=src uses the ledger WASM built by scripts/build-ledger-wasm.sh (see README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(cd ../.. && pwd)
PRESEED=${PRESEED_DIR:-$REPO/packages/extension/public/preseed}

[ -f "$REPO/packages/browser/dist/index.js" ] || { echo "run 'yarn build' at the repo root first" >&2; exit 1; }
if [ "${LEDGER:-}" = src ] && [ ! -f vendor/ledger-v8/midnight_ledger_wasm.js ]; then
  echo "LEDGER=src needs scripts/build-ledger-wasm.sh first" >&2; exit 1
fi

(cd engine && node "$REPO/node_modules/typescript/bin/tsc" -p tsconfig.json)
(cd engine && node "$REPO/node_modules/vite/bin/vite.js" build --config vite.config.mjs --configLoader native --logLevel error)
# The worker fetches snapshots from /preseed/<network>/ at the server root.
cp -R "$PRESEED" engine/dist/preseed
du -sh engine/dist
