# Moth for iOS

Moth's iPhone app. A SwiftUI app runs moth's wallet engine, unchanged, in a hidden WKWebView. Zero-knowledge proofs are made on the phone by the native Rust prover. It's preprod-only for now: use testnet funds only.

The engine page, the native prover and the ledger WASM build live in [`mobile/shared`](../shared), which the [Android app](../android/README.md) uses too. Paths below are relative to `mobile/ios`.

## What works

Verified in the iOS simulator against preprod by the UI test (`scripts/ui-test.sh`):

- create a wallet
- show its recovery phrase once for backup
- unlock with Face ID
- sync, with balances streaming in
- show receive addresses (unshielded and shielded, with QR codes)
- lock the wallet

The app also has send (fee shown first, then submit), restore from a recovery phrase, and DUST registration. These go through the same engine calls the bridge test exercises, but they haven't been run from the app UI with a funded wallet yet.

Phone measurements from the prototype this app grew out of (commit `5420145`, iPhone 17 Pro, preprod):

| Step | Time on the phone | Notes |
|---|---|---|
| Fresh wallet, launch to synced | 57–59 s | Birthday at the tip, with a pre-seed reference. |
| Restoring cached DUST state | 51–62 s, every launch | With the published ledger WASM. See [DUST restore time](#dust-restore-time). |
| DUST registration, tap to submitted | 2.1 s | Signature only, no proof. |
| Unshielded transfer, tap to submitted | 2.9 s | Build 0.9 s, prove 0.5 s (the DUST fee spend, on the phone), submit 1.4 s. |

## How it works

```
SwiftUI (Moth/)                   screens, Keychain vault, Face ID
   │  callAsyncJavaScript → window.moth.*        ▲ "moth" message handler: balances, sync, tx stages
   ▼                                             │
engine page (../shared/engine)    session (seed in memory), network configs, prover URL
   │  postMessage os/* RPC
   ▼
moth wallet worker                packages/extension/lib/offscreen/wallet-worker.ts, unmodified:
                                  wallet SDK + ledger WASM, off the page's main thread
   │  HTTP to 127.0.0.1:6300
   ▼
native prover (../shared)         midnight-ledger 8.1.3 (proof-server/), in-process, via native/ (C ABI)
```

- **The engine is the extension's wallet worker**, so the app gets moth's sync, pre-seed, DUST handling, transfers and connector operations without forking them. `../shared/engine/main.ts` stands in for the extension's service worker:
  - It holds the decrypted seed for the session. The seed never crosses to Swift.
  - It builds network configs with proving pointed at the in-app prover.
  - It exposes a small API (`list`, `create`, `importPhrase`, `unlock`, `lock`, `sync`, `balances`, `estimateFee`, `send`, `registerDust`, `parseNight`).
- **Keys.** `Moth/Wallet/Vault.swift` creates a random 32-byte keystore passphrase per wallet. It stores the passphrase in the Keychain:
  - behind `.userPresence` (Face ID, or the device passcode);
  - with `WhenPasscodeSetThisDeviceOnly`, so it is never synced or backed up.

  Moth's keystore encrypts the recovery phrase with that passphrase (scrypt + AES-GCM, in the engine's IndexedDB). The recovery phrase is the only backup.
- **Native services.** `../shared/native/` runs two servers in the app's own process, both bound to `127.0.0.1`:
  - `:6300` is the proof server, vendored from midnight-ledger `ledger-8.1.3` (`../shared/proof-server/`; its README lists the changes). It installs no tracing subscriber, because the proof server logs spend keys at debug level.
  - `:8765` serves the engine page. The fixed origin keeps IndexedDB persistent and gives the page a secure context for Web Crypto.
- **Locking.** The wallet locks when the app goes to the background and when the user taps the lock. Locking stops sync and drops the seed.
- **Network:** preprod, on moth's default endpoints (indexer `indexer.preprod.shielded.tools`).

## Build and run

Prerequisites:

- `yarn install && yarn build` at the repo root
- Xcode 16 or later
- Rust with the `aarch64-apple-ios` and `aarch64-apple-ios-sim` targets
- For a phone: an Apple developer team
- For `LEDGER=src`, also: `wasm-pack`, the `wasm32-unknown-unknown` target, and a wasm-capable clang (`brew install llvm`)

```sh
cd mobile/ios
../shared/scripts/build-ledger-wasm.sh       # optional: fixed ledger WASM into ../shared/vendor/ (see below)
LEDGER=src ../shared/scripts/build-engine.sh # ../shared/engine/dist; rerun when moth's packages change
open Moth.xcodeproj                # or build from the command line:

scripts/ui-test.sh                 # simulator UI test (fresh install, Face ID auto-matched)
TEAM_ID=… DEVICE=<udid> scripts/device.sh build
DEVICE=<udid> scripts/device.sh install
DEVICE=<udid> scripts/device.sh launch   # the phone must be unlocked
```

A checkout that built the fixed ledger before the shared code moved to `mobile/shared` still
has it in `mobile/ios/vendor/`, which git ignores. Move it, or `build-engine.sh` rebuilds it
(and needs the wasm toolchain above):

```sh
cd mobile/ios
mkdir -p ../shared/vendor && mv vendor/ledger-v8 ../shared/vendor/
ln -sfn "$(cd ../.. && pwd)/node_modules" ../shared/vendor/node_modules
```

Xcode builds the native library itself (`scripts/build-native.sh`, the "Build moth-native" phase), then copies the engine and proving keys into the app (`scripts/bundle-resources.sh`). Get the phone's UDID from `xcrun devicectl list devices`.

**Proving keys.** The wallet circuits' keys and the SRS up to 2^17 are bundled from `~/.cache/midnight/zk-params` (override with `MIDNIGHT_PP`). If they aren't there, the in-app prover downloads them on first use.

**Pre-seed.** The engine bundles the extension's `packages/extension/public/preseed`. Set `PRESEED_DIR` to use a newer `moth preseed export`.

**Debugging.** In Debug builds the engine's WebView is inspectable from Safari's Develop menu. The engine page also runs in a desktop browser while Moth is open in the simulator: open `http://127.0.0.1:8765/index.html`, which shares the Mac's loopback.

## TestFlight

`scripts/testflight.sh` archives a Release build and uploads it to App Store Connect:

```sh
TEAM_ID=… scripts/testflight.sh       # uses the account signed in to Xcode
TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=/path/AuthKey_XXXX.p8 scripts/testflight.sh   # unattended, e.g. CI
```

Before the first upload:

- The Apple Developer Program team that will own Moth (a paid membership; free personal teams can't use TestFlight) needs an app record in App Store Connect for `bob.shielded.moth`.
- Sign in to that team in Xcode (Settings → Accounts), or create an App Store Connect API key (Users and Access → Integrations, App Manager role or higher) for unattended runs. Automatic signing creates the distribution certificate and profile during the archive.
- Each upload needs a new build number; the script uses the UTC time unless `BUILD_NUMBER` is set.
- App Store Connect asks about encryption export compliance for each build until `ITSAppUsesNonExemptEncryption` is set in `Info.plist`. Moth uses HTTPS, AES and scrypt to protect the keystore, and signatures for transactions; whoever owns the listing should decide the answer.
- `Moth/PrivacyInfo.xcprivacy` declares the required-reason APIs Moth uses: `UserDefaults` for its own settings, and file timestamps (`stat`) on files in its own container, from the prover and the log.

Internal testers (members of the App Store Connect team) can install a build as soon as it finishes processing. External testers need Beta App Review once per version.

## DUST restore time

On every launch, moth restores the wallet's cached DUST state with `DustLocalState.deserialize`. With the published `@midnight-ntwrk/ledger-v8` WASM, that one call takes about a minute on preprod. It now runs in the worker, so the UI stays responsive, but sync waits for it.

The cause is in the ledger. Its deserializer cloned a map with one entry per node, once for every node it loaded, so the cost grew quadratically. Upstream fixed it in midnight-ledger `bccf2210` ("wrap IrLoader key_to_child_repr in Rc"), but no published 8.x release includes that commit. Ledger 9.1 and 10.1 pre-releases do.

Measured with the same 6.9 MB preprod DUST state on an M5 Max:

| Build | Deserialize |
|---|---|
| npm `@midnight-ntwrk/ledger-v8@8.1.0` (WASM, what moth ships) | 115.5 s |
| `ledger-8.1.0` tag built from source with wasm-pack (WASM) | 19.1 s |
| `ledger-8.1.0` tag plus the `bccf2210` fix (WASM) | 0.59 s |
| Native Rust, `ledger-8.1.3` | 13.5 s |
| Native Rust, with the fix | 0.34 s |

The patched build re-serializes the state to identical bytes and has the same exports and typings as npm 8.1.0. Why the npm build is so much slower than a plain source build of the same tag isn't known; build settings are the likeliest cause.

`../shared/scripts/build-ledger-wasm.sh` builds the `ledger-8.1.0` tag with the fix applied (`../shared/scripts/ledger-irloader-rc.patch`, the upstream diff unchanged) into `../shared/vendor/`, and `LEDGER=src ../shared/scripts/build-engine.sh` uses it instead of the npm package. That's a stopgap until a published ledger-v8 includes the fix. The extension, TUI and CLI are affected in the same way.

## Known gaps

- **One wallet, one network.** Accounts, network switching, token selection for shielded sends, and activity history are next.
- **The prover is reached over loopback HTTP.** A product build should let moth take a prover that calls native code directly, with no open port. `ProverConfig` has no such hook today.
- **Sync runs only while the app is open.** iOS suspends it in the background.
- **No DApp connector yet.**
- **Not yet measured:** a shielded transfer (the k=15 spend proof), Android, and older or low-RAM phones.
