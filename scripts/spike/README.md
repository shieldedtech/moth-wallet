# Spike: can a wallet jump its Merkle trees instead of replaying events?

DUST is 99.2% of a first sync on preprod — 1.4M events, ~78 minutes — because the
commitment and generation trees are built by inserting every event in order. The
Zcash ecosystem's answer to this is Warp Sync: compute the tree's final state
directly instead of block by block.

Midnight appears to have the primitive already. This spike asked whether it can
replace the pre-seed reference apparatus (4.9 MB bundles, CI publishing,
hour-long builds).

**Answer: not as it stands. The data is real and cheap, but a jumped tree is not
the tree a replay produces.** The open question has moved from "is this possible"
to "does the difference matter", and that needs a behavioural test rather than a
read-only one.

## What was confirmed

`node scripts/spike/warp-sync.mjs preprod 1697238`

| stage | result |
|---|---|
| The indexer serves collapsed updates for a range | ✓ `dustCommitmentMerkleTreeUpdate`, `dustGenerationMerkleTreeUpdate`, `zswapMerkleTreeCollapsedUpdate`, all `(startIndex, endIndex)` |
| Size | ✓ **657 bytes** for the commitment + generation trees at block 1,697,238 — against ~1,299,352 events replayed today |
| The ledger applies them | ✓ `DustLocalState.applyCommitmentCollapsedUpdate` / `applyGenerationCollapsedUpdate` |
| The result serializes | ✓ 3,441 bytes |
| The dust wallet can be restored from a state | ✓ `DustCoreWallet.restore(localState, publicKey, pendingTokens, syncProgress, …)` — so `syncProgress.appliedIndex` can be *set* rather than reached |

So every mechanical piece exists, wallet-side, with no SDK or indexer change.

## What was refuted

**The block's published root is not the wallet's tree root.** `Block` exposes
`dustCommitmentMerkleTreeRoot` as 33 bytes with a constant `0x73` tag; stripping
the tag and comparing both byte orders against `commitmentTreeRoot()` matches
neither, and neither does an off-by-one sweep on `endIndex`. They are different
quantities. Do not use the block field as an oracle.

**A jumped tree is not a replayed tree.** `warp-vs-replay.mjs` compares against
the right oracle — an archived reference, which reached its height by replaying
every event:

```
replayed state  ~/.moth/sync/preprod/__empty_ref__@2104384/dust.dat
  offset (dust event cursor) 1431375, state field 5.4 MB
  commitmentTreeRoot  1c602e7909faf8fb10447cc42a903d19…

warp-jumped at the same block (commitEnd=1059933)
  commitmentTreeRoot  4abc9b192afe994c00cb2c9e168e90ff…

NO MATCH
```

Note also the two index spaces the roots are taken over: the wallet's cursor is
an **event stream** index (1,431,375) while the tree is indexed by **commitment**
(1,059,933). Anything built here has to keep those apart — conflating them is
what produced the first, wrong, version of this spike.

## The question that remains

Root equality may be the wrong bar. A collapsed update exists to let a client
*append* future leaves and prove membership of *future* coins — which is exactly
what a wallet with no history below its floor needs. It may be correct for that
purpose while never reproducing the historical root.

That cannot be settled read-only. The test is behavioural:

1. Build a warp-jumped dust state at a floor, restore a wallet from it with
   `syncProgress.appliedIndex` set to the collapsed `endIndex`.
2. Sync forward to tip.
3. Compare the balance against the same wallet synced the slow way, and
   **spend from it** — the fee proof is what actually exercises the tree.

Step 3 is the real test, because a wrong tree fails at proving, not at reading.
It needs a funded wallet, so it belongs in `scripts/e2e/`, not here.

## Files

- `warp-sync.mjs` — the four-stage probe. Read-only, no wallet needed.
- `warp-vs-replay.mjs` — compares a jumped state against an archived reference.
  Needs an archived reference on disk (`moth preseed status` lists heights).
