#!/usr/bin/env bash
# Builds libmoth_native.a (the in-app proof server and engine file server) for the platform
# Xcode is building. Run by the "Build moth-native" phase of Moth.xcodeproj.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

case "${PLATFORM_NAME:-iphoneos}" in
  iphoneos) TARGET=aarch64-apple-ios ;;
  iphonesimulator) TARGET=aarch64-apple-ios-sim ;;
  *) echo "error: unsupported platform ${PLATFORM_NAME}" >&2; exit 1 ;;
esac
rustup target list --installed | grep -qx "$TARGET" || { echo "error: run 'rustup target add $TARGET'" >&2; exit 1; }

# Xcode's SDKROOT points at the iOS SDK, which breaks build scripts that compile for the Mac.
# cargo finds the right SDK per target without it.
unset SDKROOT
export CARGO_TARGET_DIR=$PWD/target
cargo build --manifest-path native/Cargo.toml --release --lib --target "$TARGET"
