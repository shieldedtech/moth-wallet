---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
'@shieldedtech/moth-tui': minor
'@shieldedtech/moth-cli': minor
---

Upgrade to `@midnightntwrk/wallet-sdk` 2.0.0, which brings `@midnightntwrk/ledger-v9` 1.0.0, and to
`@midnight-ntwrk/midnight-js` 5.0.0. The SDK runs ledger-v8 below the chain's v9 fork and ledger-v9 from it, and its
wallets follow a live chain across the boundary, so moth reaches networks on either side with one
build.

- Wallets start from per-role seeds: `WalletKeys` is now `{shielded, unshielded, dust}` seeds
  rather than ledger key objects, and the wallet holds the keys it derives from them for as long
  as it runs. Transaction-building methods no longer take key material.
- Transactions travel as version-stamped handles (`FinalizedTransaction`). Hex payloads on the
  daemon socket and dApp-supplied transactions are read with the ledger the facade is acting at,
  through the SDK's `WalletFacade.adoptTransaction`; `transactionHashOf` and
  `activeProtocolVersion` read hashes and versions off the handles.
- Proving routes by protocol version: one proof server serves both sides, and the in-process
  prover, including the extension's in-worker one, is registered per ledger version. Each backend
  refuses a transaction built by the other ledger version with `ProvingEpochMismatchError`.
- ledger-v8 now comes from `@midnightntwrk/ledger-v8` 8.1.3, the copy the SDK and midnight-js 5 both use, and the
  in-process prover from `@midnightntwrk/zkir-v2` 2.2.0, the one the SDK proves with. The `@midnight-ntwrk` copies
  are gone from the install: a second copy of a WASM ledger refuses the first one's objects.
- The client-side dedup of re-sent boundary events (`sync/sdk-dedup.ts`) is removed; the fix
  landed upstream in both wallet variants.
- DUST fee balancing keeps largest-first coin selection and moth's own balancing loop on both
  sides of the fork, through `DustWallet` rebuilt with `CustomForkingDustWallet` over the SDK's
  `dustVariantConfigurations`, so each variant is valued against the same rates. SDK 2.0.0-rc.1
  fixed the unbounded loop upstream; moth's stays because it reports each pass to the fee log.
- A DUST fee is no longer dated at a block whose DUST events the wallet has not applied, which the
  node rejected with `Custom error: 170`. When neither the newest block nor the wallet's own is safe
  to date it at, balancing re-reads the newest block every second and fails with `SyncWalletError`
  after two minutes.
- A wallet restored from a cache written below the v9 fork is started by the facade with both
  ledger versions' keys, derived from the seeds, so it resumes on whichever side its cache was
  written.
- Contract deploy, call and maintenance run on midnight-js 5 and work on both sides of the v9 fork. An
  artifact's compact-runtime version picks its ledger. One compiled by compactc 0.31 (runtime 0.16, as the
  bundled moth-ft and receive-unshielded are) is a ledger-8 contract: it deploys and takes maintenance updates
  before the fork, and stays callable after it. One compiled by compactc 0.36.0 (runtime 0.21) is a ledger-9
  contract, which runs from the fork on; the proof server (9.0.0 or later) and the in-process prover both
  prove its ZKIR v3 circuits. Artifacts compiled for any other runtime are refused.
- A contract project that has its own midnight-js runs the whole operation on that copy, so it must be on
  midnight-js 5 and have the node-zk-config, indexer, level private state and http-client proof provider
  packages. A project still on midnight-js 4 is refused with a message saying so.
- Contract artifacts are checked against `compiler/contract-manifest.json` when they carry one, as compactc
  0.36 writes it.
- The intent the wallet adds while balancing a contract transaction lives for one hour, the lifetime
  midnight-js gives the transaction itself, where it was 30 minutes.
- `createProofProvider(config, zkConfigProvider)` takes the contract's `ZKConfigProvider` rather than a key
  material provider, and returns a midnight-js 5 proof provider that serves both ledger eras.
- Message signing returns the schnorr hex value of ledger-v9's tagged signature, so the wire
  format is unchanged for connectors.
- Browser bundles now carry both ledgers' WASM, as every SDK 2.0 consumer does.
- The wait for the first facade emission no longer reaches for its own subscription: the 2.0
  facade replays state synchronously on subscribe, which turned that into a startup crash.
- The SDK's unshielded subscription now reads `protocolVersion` off the indexer's progress frame,
  so unshielded sync needs an indexer that exposes it (midnight-indexer 4.4.0-rc.2 / `25da0487`
  or later). Against an older indexer the unshielded wallet never connects.
- The unshielded wallet no longer takes the indexer's word that it is synced: it checks the
  indexer's tip against the node's finalized head, and its sync completes only once that check does
  not block. Against an indexer that is behind the node, or on another network, unshielded sync
  stays incomplete, and so do the NIGHT and DUST operations that wait for it.
- After a send or a DUST registration on a quiet wallet, unshielded sync reports complete within
  seconds, where it could stay incomplete for up to about five minutes, waiting for the indexer's
  next progress message. The NIGHT and DUST operations that wait for it no longer stall.
- A UTXO booked for a transaction that was never submitted is released once its TTL passes, and a
  resync no longer re-admits a booked UTXO as available, which could double the NIGHT balance.
- Shielded coins booked for a transaction that is never submitted or never included are released
  during sync, once the lesser of its TTL and 14 days has passed. A send or balance that fails
  part-way releases the coins it had already booked.
- Each transaction in flight is one SDK lifecycle record, from balancing to the chain's verdict,
  saved with the wallet under the same cache key; the pending list an earlier build saved is read
  back as records. A record that ends rejected or orphaned releases its coins, as before.
- A transaction the chain applies only in part releases only the coins of its failed segments;
  what its guaranteed and successful segments spent stays spent. Reverting a transaction releases
  only the DUST it spent, and pending DUST is saved with the wallet, so a restored wallet can still
  release it.
- Stopping a wallet whose node never answered now completes: the SDK's submission service
  abandons its unfinished connection on close, and nothing it started keeps retrying. The
  5-second bound on teardown, and its "Sync stop timed out" message, are gone.
- A call to the node after an idle gap, such as a send, no longer waits a second and logs
  `WebSocket is not connected` before it is served.
- A wallet restored from cache reports the protocol version its state records, rather than its
  variant's lower bound, so the protocol version shown in Settings and stamped on the transactions
  it builds is right from the first state after a restart.
- Cached wallet state and transaction history are written in the SDK's versioned formats. A
  pre-seeded snapshot, which carries no format version, still restores as the legacy format.
  Fields a newer build wrote are kept on the next save. DUST snapshots and the lifecycle records
  are written in new format versions that earlier builds refuse, so after a rollback the DUST
  wallet resyncs from genesis and the records of transactions in flight are dropped.
