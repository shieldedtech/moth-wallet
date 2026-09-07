---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-cli': minor
---

Upgrade to `@midnightntwrk/wallet-sdk` 2.0.0-beta.3. The SDK now
runs ledger-v8 below the chain's v9 fork and ledger-v9 from it, and its wallets follow a live
chain across the boundary, so moth reaches networks on either side with one build.

- Wallets start from per-role seeds: `WalletKeys` is now `{shielded, unshielded, dust}` seeds
  rather than ledger key objects, and the wallet holds the keys it derives from them for as long
  as it runs. Transaction-building methods no longer take key material.
- Transactions travel as version-stamped handles (`FinalizedTransaction`). Hex payloads on the
  daemon socket and dApp-supplied transactions are read with the ledger the wallets are acting at
  (`finalizedTransactionFromBytes`, `transactionHashOf`, `activeProtocolVersion`).
- Proving routes by protocol version: one proof server serves both sides, and the in-process
  prover, including the extension's in-worker one, is registered per ledger version.
- The client-side dedup of re-sent boundary events (`sync/sdk-dedup.ts`) is removed; the fix
  landed upstream in both wallet variants.
- Contract deploy/call/maintenance keep authoring ledger-v8 transactions through midnight-js
  4.1.1 and refuse a network that has crossed to ledger-v9.
- Message signing returns the schnorr hex value of ledger-v9's tagged signature, so the wire
  format is unchanged for connectors.
- Browser bundles now carry both ledgers' WASM, as every SDK 2.0 consumer does.
- The wait for the first facade emission no longer reaches for its own subscription: the 2.0
  facade replays state synchronously on subscribe, which turned that into a startup crash.
- The SDK's unshielded subscription now reads `protocolVersion` off the indexer's progress frame,
  so unshielded sync needs an indexer that exposes it (midnight-indexer 4.4.0-rc.2 / `25da0487`
  or later). Against an older indexer the unshielded wallet never connects.
