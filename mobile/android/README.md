# Moth for Android (spike)

A minimal Android host for moth's wallet engine: the same engine page as the iOS app
(`mobile/shared/engine`, unchanged) in a WebView, with the same native Rust prover compiled into
the app. One wallet on preprod; create, unlock, sync and balances, with the engine's events
logged on screen. Testnet funds only.

Status: a spike. It has Home and Receive (ported from the iOS app) but no Send and no DApp
connector. See [mobile/ios/README.md](../ios/README.md) for the
app this is a twin of.

## How it works

```
MainActivity (Kotlin)              buttons + log
   │  evaluateJavascript → window.moth.*       ▲ MothAndroid.event(): balances, sync, errors
   ▼                                           │
engine page (mobile/shared/engine) served by the in-app static server at http://127.0.0.1:8765
   │  postMessage os/* RPC
   ▼
moth wallet worker                packages/extension/lib/offscreen/wallet-worker.ts, unmodified
   │  HTTP to 127.0.0.1:6300
   ▼
native prover (native/)           moth-native (mobile/shared/native) via JNI; ledger 8.1.3 proof server
```

Differences from iOS:

- **The engine is served over loopback HTTP**, not a custom URL scheme. Android's
  `WebViewAssetLoader` never sees POST bodies, so the in-process prover path cannot be copied;
  the loopback proof server is used instead, which the wallet SDK already supports.
- **The engine is not modified.** It posts events to `window.webkit.messageHandlers.moth`;
  a document-start script (`Engine.kt`) provides that object, backed by a JavaScript interface.
- **Keys** are in `Vault.kt`, the Android port of `Vault.swift`: a per-wallet AES-256-GCM
  Keystore key (StrongBox when available) that needs a fingerprint or the device PIN for every
  use. The wallet locks when the app leaves the foreground. There is no biometric-only option
  yet, and no per-transaction prompt.
- **No bundled proving keys.** The prover downloads them on first proof.

## Build and run

Prerequisites:

- `yarn install && yarn build` at the repo root, then `mobile/shared/scripts/build-engine.sh`
  (patched ledger WASM by default; see "DUST restore time" in the iOS README). Without a local
  wasm32 clang, build the ledger in Docker: `rust:1.90-bookworm` plus `apt install clang llvm`
  and wasm-pack, then `LLVM_BIN=/usr/bin mobile/shared/scripts/build-ledger-wasm.sh`. ledger-8.1.0 needs
  Rust 1.89 or later (konst 0.4.3).
- Rust with the `aarch64-linux-android` target, `cargo install cross`, Docker
- Android SDK (platform 34, build-tools 34.0.0) and Gradle 8.9+, Java 17+
- A phone with USB debugging, `adb`

```sh
cd mobile/android
scripts/build-native.sh          # native/ → app/src/main/jniLibs/arm64-v8a/libmoth_android.so
scripts/bundle-engine.sh         # mobile/shared/engine/dist → app/src/main/assets/engine
ANDROID_HOME=~/Android/Sdk gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s chromium MothAndroid   # WebView console
```

`build-native.sh` pins the `ghcr.io/cross-rs/aarch64-linux-android:main` image: the default
cross 0.2.5 image ships NDK r21, which cannot link Rust 1.86 Android binaries
("cannot find -lunwind").

## Measured

`mobile/proving-bench` on a OnePlus CPH2399 (MediaTek Dimensity 1200, 8 cores, 12 GB,
Android 14), ledger 8.1.3, 6 threads, steady state: zswap output 5.4–6.1 s, spend 9.2–10 s,
peak RSS 597 MB. Raw data in `mobile/proving-bench/results/android-cph2399/`. The same
circuits take 1.2–1.3 s and 2.25–2.43 s on an iPhone 17 Pro.
