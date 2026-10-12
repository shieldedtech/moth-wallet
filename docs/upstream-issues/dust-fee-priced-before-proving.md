---
status: draft — needs one more measurement before filing
target-repos: midnightntwrk/midnight-wallet
last-updated: 2026-09-22
---

# Draft upstream issue: the DUST fee is priced before the proofs exist, and prices at 1 speck

This is a ready-to-paste GitHub issue body. It concerns the wallet SDK's fee
arithmetic. Moth does not ship a mitigation for it: the flat
`additionalFeeOverhead` in its cost parameters happens to cover the shortfall on
preprod today, which is how the behaviour went unnoticed.

---

## Title

`computeBalancingRecipe` prices a proof-erased, unproven transaction, so `feesWithMargin` returns 1 speck regardless of what the transaction carries

## Environment

| Component | Version |
|---|---|
| `@midnightntwrk/wallet-sdk` | `1.2.0` |
| `@midnightntwrk/wallet-sdk-dust-wallet` | `4.2.0` |
| `@midnightntwrk/wallet-sdk-facade` | `4.1.0` |
| `@midnight-ntwrk/ledger-v8` | `8.1.0` |
| Network | preprod |

## Summary

The fee a transfer pays is decided before the transaction has proofs, and the
object handed to the ledger for pricing has had even its placeholder proofs
erased. On preprod the ledger answers 1 speck, and that answer does not move
when the transaction gains a second transfer.

Two independent steps put the proofs out of reach:

1. **Order.** A transfer is balanced during `transferTransaction`, and only
   afterwards signed and proved. At balancing time the proofs do not exist.
2. **Erasure.** `dryRunFee` (`dist/v1/Transacting.js`) prices
   `transactions.map((tx) => tx.eraseProofs())` merged with an equally erased
   balancing transaction.

The parameters are not the problem: `RunningV1Variant` passes
`blockData.ledgerParameters`, which `Sync.js` deserializes from the indexer per
block, so pricing uses the chain's live parameters.

## Observed

A wallet holding 7,538 tNIGHT on preprod, sending unshielded tNIGHT. The fee is
`feesWithMargin(ledgerParameters, 5) + additionalFeeOverhead`, and the client's
overhead is 300,000,000,000,000 specks, so the ledger's own contribution is the
remainder.

| Transaction | Total fee (specks) | Ledger's contribution |
|---|---|---|
| 1 transfer, varying amounts, 8 samples | 300,000,000,000,001 | 1 speck |
| 2 transfers in one transaction, 3 samples | 300,000,000,000,001 | 1 speck |

The estimate and the real spend agree exactly, which is expected: both route
through `computeBalancingRecipe`.

## Why this matters

A client cannot tell an idle fee market from a fee it is structurally unable to
measure. Both read as ~0. A client that trusts the figure underpays by whatever
the proofs weigh, and only finds out when the node rejects the transaction. A
client that pads, as this one does, quotes a number to the user that is its own
constant rather than a price, and the quote cannot track the network.

## What would settle the remaining ambiguity

Whether 1 speck is the price of the erased form or simply below the resolution
of a speck at current preprod prices. Pricing the same transaction after
`finalizeRecipe` and comparing against the pre-proof figure would answer it in
one run.

## Questions

1. Is pricing the proof-erased form intentional, on the basis that verification
   cost is charged separately from size?
2. If not, can balancing move after proving, or can the ledger expose a
   "price as if proven" entry point for a transaction that is not yet proved?
3. Is `additionalFeeOverhead` the intended way for a client to cover this, and
   if so, what is the intended value and how should it track the network?

## Related

- `docs/upstream-issues/dust-fee-balancing-nontermination.md` — the same
  `computeBalancingRecipe`, a different defect.
