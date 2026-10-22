#!/usr/bin/env bash
# Builds libmoth_android.so for arm64 with cross (https://github.com/cross-rs/cross), which
# runs the Android NDK in Docker. The default cross 0.2.5 image ships NDK r21, which cannot
# link Rust 1.86 binaries ("cannot find -lunwind"), so the :main image (NDK r25) is pinned.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
export CROSS_TARGET_AARCH64_LINUX_ANDROID_IMAGE=${CROSS_TARGET_AARCH64_LINUX_ANDROID_IMAGE:-ghcr.io/cross-rs/aarch64-linux-android:main}

command -v cross >/dev/null || { echo "error: run 'cargo install cross'" >&2; exit 1; }
rustup target list --installed | grep -qx aarch64-linux-android || { echo "error: run 'rustup target add aarch64-linux-android'" >&2; exit 1; }

(cd native && cross build --release --target aarch64-linux-android "$@")
mkdir -p app/src/main/jniLibs/arm64-v8a
cp native/target/aarch64-linux-android/release/libmoth_android.so app/src/main/jniLibs/arm64-v8a/
ls -la app/src/main/jniLibs/arm64-v8a/libmoth_android.so
