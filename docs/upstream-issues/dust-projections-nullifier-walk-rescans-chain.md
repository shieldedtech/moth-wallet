---
status: draft — not yet filed
target-repos: midnightntwrk/midnight-wallet
last-updated: 2026-11-17
---

# Draft upstream issue: a projections pass rescans the whole chain once per DUST spend

This is a ready-to-paste GitHub issue body. It concerns the DUST wallet's
projections sync. Moth ships a mitigation: `makeProjectionsSyncService` in
`packages/core/src/sync/dust-transacting.ts` replaces the lookup with one that
starts where the previous one matched (`sync/dust-nullifier-walk.ts`). Remove it
once the SDK bounds the lookup itself.

---

## Title

`resolveNullifierSpends` opens every `dustNullifierTransactions` lookup at `fromBlock: 0`, so a pass costs one whole-chain scan per spend in the wallet's history

## Environment

| Component | Version |
|---|---|
| `@midnightntwrk/wallet-sdk` | `2.0.1-rc.0` |
| `@midnightntwrk/wallet-sdk-dust-wallet` | `5.1.0-rc.0` |
| `@midnightntwrk/wallet-sdk-indexer-client` | `2.0.1-rc.0` |
| Network | mainnet, protocol version `2001100`, block ~3,497,000 |

## Summary

`doEventlessSync` resolves spends by following each coin's chain: look up the
nullifier, derive the successor from the spend that matched, look up the
successor's nullifier, and so on until a lookup matches nothing. Each step is a
`dustNullifierTransactions` subscription, and
`makeIndexerSyncService().subscribeDustNullifierTransactions` hardcodes
`fromBlock: 0`.

With the default `anonymityLevel` of 7 the prefix on mainnet is one byte, so one
lookup returns 1/256 of every DUST spend on the chain: about 8,600 messages and
22 MB of JSON, taking 50–60 seconds. A wallet that has spent DUST *n* times
therefore needs roughly *n* minutes for its first pass after the ledger-v9
hand-over, and the cost grows with both the wallet's history and the chain's.

Two properties of the pass make that worse than slow:

1. **Nothing is applied until the pass ends.** The pass runs inside
   `Stream.asyncEffect`'s register effect, so its `ProgressUpdate`s are buffered
   with the final `StateUpdate`. Until then the wallet reports
   `highestRelevantWalletIndex: 0` and `isConnected: false`: no progress to
   show, and nothing a snapshot can save.
2. **Nothing is resumable.** A wallet stopped mid-pass restarts the walk from
   the first coin.

## Reproduction

Observed on mainnet with a wallet handed over from the ledger-v8 variant (empty
ledger-v9 state, cursor parked on the last ledger-v8 event). The pass ran for
about 30 minutes before its first update was applied, streaming from the indexer
at a steady ~170 KB/s on a single connection throughout. The same pass for the
same public key, run with a secret key that matches no spend, completes in 71
seconds: one lookup.

Timing of a single lookup, prefix `a7`, `toBlock` at the tip:

| `fromBlock` | Messages | Payload | Time |
|---|---|---|---|
| `0` | 8,634 | 22.1 MB | 58 s |
| tip − 17,780 | 196 | 0.6 MB | 2 s |

## Suggested fix

A coin cannot be spent before the block that created it, and every nullifier
looked up after the first step belongs to a coin created by a transaction the
previous step matched. So the next lookup can start at the lowest `blockHeight`
among the previous step's matches, inclusive, since the successor can be spent
later in that same block.

In `resolveNullifierSpends` that is one more value threaded through
`Stream.unfoldEffect`, and a `fromBlock` parameter on
`subscribeDustNullifierTransactions`. The whole walk then covers the chain
roughly once instead of once per spend.

The same bound applies to the steady state. A settled wallet holding DUST
repeats the whole-chain lookup for its held nullifiers on every background pass,
five seconds apart by default. A snapshot written by a projections pass records
the height that pass reached, which is a sound `fromBlock` for the first lookup
of the next one. Moth's mitigation does not do this.
