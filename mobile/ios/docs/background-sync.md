# Background sync: feasibility

**Verdict:** full background sync is not worth building on the current architecture. A narrower watcher for unshielded balances is feasible and needs no secrets.

## Why not full sync

- **Shielded and DUST sync need spend keys.** The shielded wallet replays every zswap event with `ZswapSecretKeys`. Replay decrypts with the encryption key and then computes nullifiers with the coin secret key (midnight-ledger `zswap/src/local.rs`). DUST sync needs `DustSecretKey`, which also authorises spending DUST (`ledger/src/dust.rs`). Running either while locked means storing spend keys without Face ID, which for shielded funds is about as sensitive as the seed. Unshielded sync needs only a public key.
- **WKWebView is not dependable in the background.** The engine runs in WebKit's WebContent and Networking processes, which iOS suspends on their own schedule. No public API keeps them alive during a `BGTask`, so the worker, its WebSockets and IndexedDB can stop mid-sync.
- **The budgets are small and unpredictable.** `BGAppRefreshTask` gets up to 30 s at times the system chooses. `BGProcessingTask` gets minutes, usually overnight on power. Silent pushes are best-effort, two or three an hour. `BGContinuedProcessingTask` (iOS 26) must start in the foreground from a user action.

## What 30 seconds buys

Catching up is cheap: ADR 0004 measured 25,660 blocks in 9.1 s. The fixed cost of starting the engine dominates. With the patched ledger WASM (now the default; see the README), restoring DUST state takes under a second instead of about a minute. So a refresh window could cover a cold start plus hours of blocks, if WebKit stayed up. Without the patch it could not.

## Recommended

1. **Native unshielded watcher** on `BGAppRefreshTask`: query the indexer for the account's public unshielded address only, and post a local notification when its balance changes. It needs no secrets. The indexer and push path learn nothing beyond what the public address already reveals.
2. **Optional:** use `BGContinuedProcessingTask` to let a long first sync or restore continue when the user leaves the app, while the session is unlocked. This needs a device test of whether WebContent survives it.
3. Keep spend keys behind `.userPresence`; do not add a weaker key tier for sync.

## Changes this would need in moth core

- Split `WalletKeys`, so unshielded sync can run from a public key alone.
- Expose a bounded `catchUp(deadline)` whose `stop()` flushes state to the store before the deadline.
- An encryption-key-only receive detector for shielded funds would need ledger or SDK support; today's sync API takes the full `ZswapSecretKeys`.

## Open risks

- Whether WebContent survives background tasks is unmeasured.
- The sync cache in IndexedDB is not encrypted (`packages/browser/src/adapters/idb-sync-store.ts`); background launches would leave it readable after first unlock.
- iOS may rarely or never schedule refresh tasks for a given user.
