#!/usr/bin/env bash
# Builds libmoth_android.so with cross (https://github.com/cross-rs/cross), which runs the
# Android NDK in Docker. The default cross 0.2.5 images ship NDK r21, which cannot link
# Rust 1.86 binaries ("cannot find -lunwind"), so the :main images (NDK r25) are pinned.
#
#   scripts/build-native.sh                     # arm64-v8a (phones)
#   ABIS="arm64-v8a x86_64" scripts/build-native.sh   # also x86_64, for emulators and CI
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
export CROSS_TARGET_AARCH64_LINUX_ANDROID_IMAGE=${CROSS_TARGET_AARCH64_LINUX_ANDROID_IMAGE:-ghcr.io/cross-rs/aarch64-linux-android:main}
export CROSS_TARGET_X86_64_LINUX_ANDROID_IMAGE=${CROSS_TARGET_X86_64_LINUX_ANDROID_IMAGE:-ghcr.io/cross-rs/x86_64-linux-android:main}

command -v cross >/dev/null || { echo "error: run 'cargo install cross'" >&2; exit 1; }
for abi in ${ABIS:-arm64-v8a}; do
  case $abi in
    arm64-v8a) target=aarch64-linux-android ;;
    x86_64) target=x86_64-linux-android ;;
    *) echo "error: unsupported ABI $abi (arm64-v8a, x86_64)" >&2; exit 1 ;;
  esac
  rustup target list --installed | grep -qx $target || { echo "error: run 'rustup target add $target'" >&2; exit 1; }
  (cd native && cross build --release --target $target "$@")
  mkdir -p app/src/main/jniLibs/$abi
  cp native/target/$target/release/libmoth_android.so app/src/main/jniLibs/$abi/
  ls -la app/src/main/jniLibs/$abi/libmoth_android.so
done
