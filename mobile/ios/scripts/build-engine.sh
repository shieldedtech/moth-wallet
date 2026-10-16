#!/usr/bin/env bash
# Builds the engine page (engine/dist): moth's wallet worker plus the Swift bridge, with the
# pre-seed snapshots the extension bundles. Run after `yarn install && yarn build` at the
# repo root, and again whenever moth's packages change.
#
# The ledger WASM is built from source with the DUST-restore fix (scripts/build-ledger-wasm.sh,
# see README.md); LEDGER=npm uses the published package instead.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(cd ../.. && pwd)
PRESEED=${PRESEED_DIR:-$REPO/packages/extension/public/preseed}

[ -f "$REPO/packages/browser/dist/index.js" ] || { echo "run 'yarn build' at the repo root first" >&2; exit 1; }
export LEDGER=${LEDGER:-src}
if [ "$LEDGER" = src ] && [ ! -f vendor/ledger-v8/midnight_ledger_wasm.js ]; then
  scripts/build-ledger-wasm.sh
fi

(cd engine && node "$REPO/node_modules/typescript/bin/tsc" -p tsconfig.json)
(cd engine && node "$REPO/node_modules/vite/bin/vite.js" build --config vite.config.mjs --configLoader native --logLevel error)
# The DApp-page script is a single classic script, injected by Swift as a WKUserScript.
"$REPO/node_modules/.bin/esbuild" engine/inject.ts --bundle --format=iife --target=es2022 --minify \
  --alias:moth-ext="$REPO/packages/extension/lib" --outfile=engine/dist/inject.js --log-level=warning
# The worker fetches snapshots from /preseed/<network>/ at the server root.
cp -R "$PRESEED" engine/dist/preseed
du -sh engine/dist
