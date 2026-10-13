#!/usr/bin/env bash
# Builds the iOS app at mobile/ios/build/MothSpike.app:
#   1. the web page (moth's browser build, from this repo's packages/)
#   2. the native library (in-app proof server + static file server) for aarch64-apple-ios
#   3. the bundled proving keys and SRS
#   4. the Swift host, signed for a development device
#
# Prerequisites: `yarn install && yarn build` at the repo root, Xcode, Rust with the
# aarch64-apple-ios target, and an Apple Development identity plus a provisioning profile
# that covers the bundle id below and your device.
#
#   TEAM_ID=XXXXXXXXXX SIGN_ID="Apple Development: …" PROFILE=/path/to.mobileprovision ./build.sh
#
# LEDGER=src uses the ledger WASM built by scripts/build-ledger-wasm.sh (see README.md).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
REPO=$(cd ../.. && pwd)
: "${TEAM_ID:?set TEAM_ID to your Apple developer team id}"
: "${SIGN_ID:?set SIGN_ID to your Apple Development signing identity (name or SHA-1)}"
: "${PROFILE:?set PROFILE to a .mobileprovision covering $TEAM_ID.io.shielded.mothmobilespike}"
BUNDLE_ID=io.shielded.mothmobilespike
PP=${MIDNIGHT_PP:-$HOME/.cache/midnight/zk-params}
PRESEED=${PRESEED_DIR:-$REPO/packages/extension/public/preseed/preprod}
export CARGO_TARGET_DIR=$ROOT/target

[ -f "$REPO/packages/browser/dist/index.js" ] || { echo "run 'yarn build' at the repo root first" >&2; exit 1; }
if [ "${LEDGER:-}" = src ] && [ ! -f vendor/ledger-v8/midnight_ledger_wasm.js ]; then
  echo "LEDGER=src needs scripts/build-ledger-wasm.sh first" >&2; exit 1
fi

# 1. Web page. The DUST/shielded pre-seed reference is the one the extension bundles,
# unless PRESEED_DIR points at a newer `moth preseed export`.
(cd web && node "$REPO/node_modules/vite/bin/vite.js" build --config vite.config.mjs --configLoader native --logLevel warn)
mkdir -p web/dist/preseed && cp -R "$PRESEED" web/dist/preseed/preprod

# 2. Native library.
(cd native && cargo build --release --lib --target aarch64-apple-ios)

# 3. Proving material: the built-in wallet circuits (zswap + dust; version dir 9 is
# ledger 8.1.x) and SRS up to 2^17. Anything missing is downloaded by the in-app proof
# server on first use, so a build without a local cache still works, just slower at first.
rm -rf build/params && mkdir -p build/params/zswap build/params/dust
if [ -d "$PP/zswap/9" ] && [ -d "$PP/dust/9" ]; then
  cp -R "$PP/zswap/9" build/params/zswap/ && cp -R "$PP/dust/9" build/params/dust/
  for k in 10 11 12 13 14 15 16 17; do [ -f "$PP/bls_midnight_2p$k" ] && cp "$PP/bls_midnight_2p$k" build/params/; done
else
  echo "note: no zk params at $PP; the app will download them on first proof" >&2
fi

# 4. Swift host, bundle, signature.
A=build/MothSpike.app
rm -rf "$A" && mkdir -p "$A"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
xcrun --sdk iphoneos swiftc -O -parse-as-library -target arm64-apple-ios17.0 -sdk "$SDK" \
  -import-objc-header app/native.h app/App.swift \
  -L target/aarch64-apple-ios/release -lmoth_native -lc++ -framework Security -framework SystemConfiguration \
  -o "$A/MothSpike" 2> >(grep -v '^ld: warning' >&2)
cp app/Info.plist "$A/" && cp -R web/dist "$A/web" && cp -R build/params "$A/params"
cp "$PROFILE" "$A/embedded.mobileprovision"
cat > build/ent.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$TEAM_ID.$BUNDLE_ID</string>
<key>com.apple.developer.team-identifier</key><string>$TEAM_ID</string>
<key>get-task-allow</key><true/>
</dict></plist>
PLIST
codesign --force --sign "$SIGN_ID" --entitlements build/ent.plist --timestamp=none "$A"
codesign --verify --deep --strict "$A"
du -sh "$A"
