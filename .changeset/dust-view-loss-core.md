---
'@shieldedtech/moth-wallet': minor
---

Check the DUST view against the chain, release fee coins of transactions that
never land, and recover from a rejected replay instead of retrying it forever.

The dust wallet's state is incremental and forward-only: events are applied as
they arrive and nothing ever re-derives from the chain. Three ways that went
wrong on preprod between 2026-09-20 and 22, all reported as `dustSynced: true`:

- A wallet paying contract fees lost sight of a ≈500 DUST coin for three hours
  and every fee after that failed with "could not balance dust". The coin was
  not lost: `DustLocalState.spend()` marks the input pending for the ledger's
  grace period and hides it from `utxos`, and only the `DustSpendProcessed`
  event replaces it with its successor. The transaction that spent it had been
  accepted by the pool and never included — no event, so no successor, and a
  submission resolved at 'Submitted' has no way to notice.
- Two wallets looped 9,300 times over five hours on `values inserted
  non-linearly into dust commitment tree`, a failure the dedup wrapper already
  explains cannot recover on retry.
- A pre-seeded cache gave a wallet with generation history a permanent 0 DUST.

What changes:

- **A revert that reverts** (`sync/dust-transacting.ts`). The SDK's own revert
  clears the lock with `processTtls(ctime + grace)`, but only for spends it
  still finds in the wallet's in-memory `pendingDust`, and that list is pruned
  on every sync batch against `utxos` — which hides exactly the coin the list
  exists to remember. Within seconds of a spend every revert path was a silent
  no-op: the facade's revert when the node rejects the submission (the 13:55Z
  incident was a rejected proof, not a dropped transaction), the SDK's TTL
  revert, and any watch built on top. The transacting capability moth already
  replaces now un-pends every dust spend in the transaction unconditionally.
- **Spends declared at the sync point** (`sync/dust-transacting.ts`). The node
  verifies a dust spend against the tree root of the block at or before the
  spend's declared `ctime`, kept for the trailing hour; the wallet's proof
  commits to its local root, which advances only as events are applied. The SDK
  declares the indexer's tip time, so whenever any dust event has landed in a
  block the wallet has not applied yet, the roots differ and the node rejects
  the proof (`InvalidDustSpendProof`, "Custom error: 170") — about one fee in
  fifty on preprod, clustered right after a landed spend. Spends and estimates
  now declare `DustLocalState.syncTime`, the block time of the last applied
  event, whose root is exactly the wallet's, unless that is older than 45
  minutes.
- **Inclusion watch** (`sync/tx-watch.ts`). Every submission is polled against
  the indexer; one not seen within ten minutes has its bookkeeping reverted
  through `facade.revertTransaction`, which the dust wallet maps to
  `processTtls(spendTime + grace)` — the ledger un-pends the coin. Safe if the
  transaction lands later: the event finds the coin by nullifier regardless.
- **Dust view check** (`sync/dust-view.ts`, `sync/dust-generations.ts`). Once
  dust reports synced, and every five minutes after, the wallet fetches its
  generation entries from the indexer's `dustGenerations(dustAddress)` and the
  live dust tip, and compares: every live entry must have a coin in the local
  view, no coin may lack a generation record, and the cursor must move. A live
  entry with no coin for more than ten minutes, an excluded coin, a stalled
  cursor or a rejected replay makes the view incomplete. `WalletBalances` gains
  `dustView` saying so, and `syncProgress.dustSynced` is false while it is.
- **A check that cannot reach the indexer says so.** The verdict carries a
  `status` — `unchecked`, `complete`, `incomplete`, `unknown` — and only a
  current `incomplete` withholds `dustSynced`. A failed attempt turns the
  verdict `unknown` (previous findings kept for context, not in force), is
  retried after 30 seconds rather than at the next 5-minute check, and a
  verdict older than 15 minutes without a fresh answer expires. Observed on
  preprod 2026-09-23 03:41–03:47Z: a 403/503 window kept a stale "incomplete"
  in force on one wallet, idling 1,459 DUST for twenty minutes, while on another
  it kept a stale "complete" over a coin fifteen minutes missing.
- **Restart on stall.** A check that finds the dust cursor frozen while the
  indexer's tip advances stops and restarts the sync from its caches (at most
  once per ten minutes). The SDK's subscription client is created with
  `shouldRetry: () => false`, so a wallet that lived through an indexer outage
  otherwise stayed at 99% with all three parts unsynced until its process was
  restarted.
- **Per-coin dust valued at now.** The SDK's `availableCoins` values each coin
  at the state's sync time, so under a stalled sync the per-coin figures froze
  while the headline balance kept growing (1,391 against coins summing to
  1,217). Both now use the same instant.
- **Auto-recovery.** The dedup wrapper now takes hooks. On a non-linear insert
  the affected part's cache is evicted and the sync restarted, at most once an
  hour per part. `SyncedWallet` gains `rebuildDust()`, `restartSync()` and
  `checkDustView()`; the facade is replaced across a restart, so hold the
  `SyncedWallet`.
- **Daemon.** `getState` returns the per-coin breakdown (`coins`, with each dust
  coin's backing NIGHT, spend sequence, initial value and creation time),
  `dustGeneration`, `subProgress` and `dustView`. New verbs: `checkDustView`
  (read), `rebuildDust` and `restartSync` (audited writes).
- **Offline check.** `checkCachedDustView` reads a cached `dust.dat` and compares
  it with the chain without starting a sync.
- The pre-seed history probe inlines its integers: the public preprod indexer
  intermittently rejects them as GraphQL variables, and the probe fell back to a
  from-genesis sync for no reason.

Indexer event ids are one global serial shared with zswap and contract events,
so an id-contiguity check is not a gap detector (twelve gaps in four hundred
ids on preprod); gaps are reported through a diagnostic hook only, and the
ledger tree's own rejection remains the verdict.
