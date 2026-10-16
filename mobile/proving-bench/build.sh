#!/usr/bin/env bash
# Builds the Mac binary, generates k-sweep keys, assembles the offline param bundle,
# builds the iOS static library and the signed MNProveBench.app.
#   TEAM_ID=… SIGN_ID=… PROFILE=… ./build.sh [k-list for the sweep, default 10..20]
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
KS=${1:-10,11,12,13,14,15,16,17,18,19,20}
PP=${MIDNIGHT_PP:-$HOME/.cache/midnight/zk-params}
: "${TEAM_ID:?set TEAM_ID to your Apple developer team id}"
: "${SIGN_ID:?set SIGN_ID to your Apple Development identity (security find-identity -v -p codesigning)}"
: "${PROFILE:?set PROFILE to a .mobileprovision covering $TEAM_ID.io.shielded.mnprovebench}"
BUNDLE_ID=io.shielded.mnprovebench
export CARGO_TARGET_DIR=$ROOT/target

(cd bench && cargo build --release)
rustup target add aarch64-apple-ios >/dev/null
(cd bench && cargo build --release --lib --target aarch64-apple-ios)

# Offline bundle: zswap keys (version dir 9 for ledger 8.1.x) + SRS for every k we prove.
# Run the wallet benchmark once on the Mac first if the cache is empty: it downloads into $PP.
rm -rf params && mkdir -p params/zswap
cp -R "$PP/zswap/9" params/zswap/
for k in 13 14 15 ${KS//,/ }; do cp -n "$PP/bls_midnight_2p$k" params/ 2>/dev/null || true; done

# k-sweep keys (keygen runs on the Mac; k=20 takes ~40 s and ~260 MB of key).
mkdir -p build
[ -f "ksweep-keys/k${KS##*,}.pk" ] || ./target/release/mn-mobile-bench gen "$PP" ksweep-keys "$KS" | tee build/keygen.log

A=build/MNProveBench.app
rm -rf "$A" && mkdir -p "$A"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
xcrun --sdk iphoneos swiftc -O -parse-as-library -target arm64-apple-ios17.0 -sdk "$SDK" \
  -import-objc-header app/bench.h app/App.swift \
  -L target/aarch64-apple-ios/release -lmn_mobile_bench -lc++ -framework Security -framework SystemConfiguration \
  -o "$A/MNProveBench" 2> >(grep -v '^ld: warning' >&2)
cp app/Info.plist "$A/" && cp -R params "$A/params" && cp -R ksweep-keys "$A/ksweep-keys"
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
