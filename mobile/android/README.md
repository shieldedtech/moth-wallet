# Moth for Android (spike)

A minimal Android host for moth's wallet engine: the same engine page as the iOS app
(`mobile/shared/engine`, unchanged) in a WebView, with the same native Rust prover compiled into
the app. One wallet on preprod; create or restore, unlock, sync, balances, Send NIGHT and DUST
registration, with the engine's events logged on screen. Testnet funds only.

Status: a spike. It has Home, Receive, Send NIGHT and DUST registration and deregistration
(ported from the iOS app), but no DApp connector. Shielded sends are in the Send screen but
not tested yet. See [mobile/ios/README.md](../ios/README.md) for the
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
  use. The wallet locks when the app leaves the foreground. Every transaction (send, DUST
  registration) asks for a fingerprint or the device PIN; on iOS that is an opt-in setting.
  There is no biometric-only option yet.
- **No bundled proving keys.** The prover downloads them on first proof. That download needs
  `Native.initTls` first: the prover's HTTPS client (rustls-platform-verifier) uses Android's
  certificate verifier and must be given the app context, or the first download panics
  ("Expect rustls-platform-verifier to be initialized") and sends fail with "Failed to prove
  transaction". Gradle finds the verifier's Kotlin half (a local Maven repository inside the
  `rustls-platform-verifier-android` crate) with `cargo metadata`, so `cargo` must be on the
  PATH for the Gradle build.

## Build and run

Prerequisites:

- `yarn install && yarn build` at the repo root, then `mobile/shared/scripts/build-engine.sh`
  (patched ledger WASM by default; see "DUST restore time" in the iOS README). Without a local
  wasm32 clang, build the ledger in Docker: `rust:1.90-bookworm` plus `apt install clang llvm`
  and wasm-pack, then `LLVM_BIN=/usr/bin mobile/shared/scripts/build-ledger-wasm.sh`. ledger-8.1.0 needs
  Rust 1.89 or later (konst 0.4.3). A ledger built before the move to `mobile/shared` is still
  in `mobile/ios/vendor/`; move it as the iOS README shows rather than rebuilding it.
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

## Restore and test-build tools

The Welcome screen has "Restore from recovery phrase". Debug builds also have:

- **Start over** (Locked and Logs screens): deletes the wallet, its Keystore key and all app
  data, and closes the app.
- **Import sync state synced on a computer**, so a restore skips the scan from genesis. Restore
  and sync the same phrase with the moth CLI or TUI, stop it, then:

  ```sh
  scripts/push-sync-state.sh <wallet> [network]   # network defaults to preprod
  ```

  `MOTH_HOME` (default `~/.moth`) is where the synced state is; `APP_ID` (default
  `io.shielded.moth`) picks the app, e.g. `APP_ID=io.shielded.moth.fresh` for a build with
  `-PmothAppSuffix=.fresh`. Then choose Restore in the app and enter the phrase. The app checks
  the state's address against the phrase, loads it before the first sync and deletes the pushed
  copy.

## UI tests

`app/src/androidTest` holds Compose UI tests ported from `mobile/ios/MothUITests`; so far
`OnboardingTests` (create, back up, unlock, sync, DUST registration on an empty wallet, Receive,
lock, relaunch). `scripts/ui-test.sh` runs them like the iOS script: a fresh install of a
separate app ID (`-PmothAppSuffix=.uitest`, so a real wallet is never touched), with every
fingerprint prompt answered by `adb emu finger touch 1`. It uses emulators only, never a phone.

```sh
scripts/build-native.sh && scripts/bundle-engine.sh
ANDROID_HOME=~/Android/Sdk scripts/ui-test.sh      # TESTS=..., AVD=..., GRADLE=...
```

One-time emulator setup: set a screen lock PIN (`adb -e shell locksettings set-pin 1111`),
then Settings → Security → Fingerprint, and answer each "touch the sensor" step with
`adb -e emu finger touch 1`.

The emulator must run arm64 code, because the native prover is built only for `arm64-v8a`:

- **arm64 system image**: runs only on an arm64 host (an Apple-silicon Mac).
- **x86_64 image, API 30 or later, Google APIs**: these images translate ARM app code, so the
  arm64-only APK installs on an x86_64 Linux or Intel host. Not tried with this prover; expect
  it to be slow.
- **x86_64 build of the native library** (not done yet): `cross build --target
  x86_64-linux-android` with the `ghcr.io/cross-rs/x86_64-linux-android:main` image, copied to
  `jniLibs/x86_64`, plus `x86_64` in `abiFilters` for test builds. Native speed on a KVM
  emulator, so it is the route for CI on the Linux runners the Android build job uses.

## Measured

`mobile/proving-bench` on a OnePlus CPH2399 (MediaTek Dimensity 1200, 8 cores, 12 GB,
Android 14), ledger 8.1.3, 6 threads, steady state: zswap output 5.4–6.1 s, spend 9.2–10 s,
peak RSS 597 MB. Raw data in `mobile/proving-bench/results/android-cph2399/`. The same
circuits take 1.2–1.3 s and 2.25–2.43 s on an iPhone 17 Pro.
