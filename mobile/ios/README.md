# moth on iOS (prototype)

This prototype runs moth's unmodified browser build inside an iPhone app, with zero-knowledge proofs made on the phone by the native Rust prover. It's for preprod testing only, and its keystore passphrase is fixed (see below), so use testnet funds only.

## Status

It works end to end on an iPhone 17 Pro: create a wallet, sync, receive tNIGHT, register for DUST, and send a transfer whose DUST fee proof is made on the phone.

| Step | Time on the phone | Notes |
|---|---|---|
| Fresh wallet, launch to synced | 57–59 s | Birthday at the tip, with a pre-seed reference. |
| Relaunch after 3 days offline, to synced | 55–65 s | Almost all of it is restoring cached DUST state. |
| Restoring cached DUST state | 51–62 s, every launch | With the published ledger WASM. See [DUST restore time](#dust-restore-time). |
| DUST registration, tap to submitted | 2.1 s | Signature only, no proof. |
| Unshielded transfer, tap to submitted | 2.9 s | Build 0.9 s, prove 0.5 s (the DUST fee spend, on the phone), submit 1.4 s. |

These figures come from a handful of runs on 2026-10-10 and 2026-10-13. The native side used 12–22 MB of memory idle and 68 MB after the first proof, thermal state stayed nominal throughout, and the app is about 130 MB.

## How it works

- **No changes to moth.** Moth's `server` prover mode posts proof requests over HTTP. The app runs two servers in its own process, both bound to `127.0.0.1` so nothing off the phone can reach them:
  - `:6300` is the Midnight proof server, vendored from midnight-ledger `ledger-8.1.3` (`proof-server/`; its README lists the changes).
  - `:8765` serves the web page (`native/src/lib.rs`). The fixed origin gives the page persistent IndexedDB and a secure context for Web Crypto.
- **`app/App.swift`**, the Swift host:
  - copies the bundled proving keys to `Caches/zk-params`
  - starts both servers
  - injects `window.MOTH_PROVER_URL`
  - loads the page in a WKWebView
  - mirrors the page's log, plus native memory and thermal state every 10 s, to `Documents/spike-log.txt`
- **`web/`**, a single page on `@shieldedtech/moth-browser`:
  - Startup checks for the prover, the indexer (GraphQL over HTTPS) and the node (JSON-RPC over WebSocket). The node sends no CORS headers, so a plain HTTPS request to it fails in the WebView, while moth's WebSocket connection works.
  - A status line and balances. NIGHT is shown in NIGHT and DUST in DUST, not in STAR and SPECK; other tokens are tagged with a color derived from their token id.
  - Register DUST, and Send. NIGHT amounts are typed in NIGHT; other tokens use base units.
- **Network:** preprod, through `indexer.preprod.shielded.tools`.
- **Wallet:** created on first launch as `phone`, under the fixed passphrase in `web/main.ts`, so launches need no input. That passphrase protects nothing, which is why this build is for testnet funds only.

## DUST restore time

On every launch, moth restores the wallet's cached DUST state with `DustLocalState.deserialize`. With the published `@midnight-ntwrk/ledger-v8` WASM, that one call takes about a minute on preprod, and it blocks the page.

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

`scripts/build-ledger-wasm.sh` builds the `ledger-8.1.0` tag with the fix applied (`scripts/ledger-irloader-rc.patch`, the upstream diff unchanged) into `vendor/`, and `LEDGER=src ./build.sh` uses it instead of the npm package. That's a stopgap until a published ledger-v8 includes the fix. The extension, TUI and CLI are affected in the same way.

## Build and run

Prerequisites:

- `yarn install && yarn build` at the repo root
- Xcode
- Rust with the `aarch64-apple-ios` target
- an Apple Development identity, and a provisioning profile covering `<TEAM_ID>.io.shielded.mothmobilespike` and your phone
- For `LEDGER=src`, also: `wasm-pack`, the `wasm32-unknown-unknown` target, and a wasm-capable clang (`brew install llvm`)

```sh
cd mobile/ios
scripts/build-ledger-wasm.sh          # optional: fixed ledger WASM into vendor/
TEAM_ID=… SIGN_ID=… PROFILE=… LEDGER=src ./build.sh
DEVICE=<udid> scripts/device.sh install
DEVICE=<udid> scripts/device.sh launch   # the phone must be unlocked
DEVICE=<udid> scripts/device.sh log      # copies Documents/spike-log.txt to build/
```

Get the phone's UDID from `xcrun devicectl list devices`.

**Proving keys.** `build.sh` bundles the wallet circuits' keys and the SRS up to 2^17 from `~/.cache/midnight/zk-params` (override with `MIDNIGHT_PP`). If they aren't there, the in-app proof server downloads them on first use.

**Pre-seed.** The pre-seed reference is the extension's `packages/extension/public/preseed/preprod`. Set `PRESEED_DIR` to use a newer `moth preseed export`.

**Debugging.** The WebView is inspectable from Safari's Develop menu on a Mac.

**Mac runner.** `cargo run --release --example run -- <zk-params-dir> web/dist` in `native/` starts both servers on a Mac, so the page can be opened in a desktop browser.

## Known gaps

- **The page blocks while DUST state loads.** It's about a minute with the published ledger WASM, and under a second with the fix above. Moth's engine still runs on the page's main thread; a web worker would keep the UI responsive.
- **The prover is reached over loopback HTTP.** That avoids changing moth. A product build should let moth take a prover that calls native code directly, with no HTTP server and no open port. `ProverConfig` has no such hook today.
- **Sync runs only while the app is open.** iOS suspends it in the background.
- **Not yet measured:** a shielded transfer (the k=15 spend proof), Android, and older or low-RAM phones.
