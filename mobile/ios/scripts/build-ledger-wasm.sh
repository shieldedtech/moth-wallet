#!/usr/bin/env bash
# Builds @midnight-ntwrk/ledger-v8 from the midnight-ledger `ledger-8.1.0` tag (the release the
# npm package was built from) plus one upstream fix, into vendor/ledger-v8 in the same layout as
# the npm package, for `LEDGER=src ./build.sh`.
#
# Why: every published ledger-v8 8.x deserializes wallet state in O(n^2) time. IrLoader cloned
# a map with one entry per node for every node it loaded; upstream fixed it in bccf2210, which
# no 8.x release includes. On preprod that makes restoring the cached DUST state take about a
# minute on every launch. scripts/ledger-irloader-rc.patch is that commit's diff, unchanged.
#
# Needs wasm-pack, the wasm32-unknown-unknown Rust target and a clang that can target
# wasm32 (Apple's cannot; `brew install llvm` provides one).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(cd ../.. && pwd)
TAG=${LEDGER_TAG:-ledger-8.1.0}
LLVM=${LLVM_BIN:-$(brew --prefix llvm 2>/dev/null)/bin}
NPM_PKG=$REPO/node_modules/@midnight-ntwrk/ledger-v8
SRC=vendor/ledger-src

[ -x "$LLVM/clang" ] || { echo "no wasm-capable clang at $LLVM (set LLVM_BIN)" >&2; exit 1; }
if [ ! -d "$SRC" ]; then
  git clone --quiet --depth 1 --branch "$TAG" https://github.com/midnightntwrk/midnight-ledger "$SRC"
  git -C "$SRC" apply "$PWD/scripts/ledger-irloader-rc.patch"
fi

rm -rf vendor/ledger-v8
(cd "$SRC/ledger-wasm" && \
  CC_wasm32_unknown_unknown="$LLVM/clang" AR_wasm32_unknown_unknown="$LLVM/llvm-ar" \
  wasm-pack build --release --target bundler --out-dir "$PWD/../../ledger-v8" --out-name midnight_ledger_wasm)
# Keep the npm package's entry points (its package.json `imports`, the Node loader and the
# published typings) so the swap is invisible to everything that imports it.
cp "$NPM_PKG/package.json" "$NPM_PKG/midnight_ledger_wasm_fs.js" "$NPM_PKG/ledger-v8.d.ts" vendor/ledger-v8/
rm -f vendor/ledger-v8/.gitignore
# Bare imports in the generated glue resolve from the repo's node_modules.
ln -sfn "$REPO/node_modules" vendor/node_modules
echo "built $TAG + ledger-irloader-rc.patch -> vendor/ledger-v8"
