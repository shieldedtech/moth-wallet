---
status: draft — ready to file
target-repos: midnightntwrk/midnight-node, midnightntwrk/midnight-ledger
last-updated: 2026-09-02
---

# Draft upstream issue: a devnet can stop accepting every fee-paying transaction, permanently, after a DUST registration

This is a ready-to-paste GitHub issue body. It is not a Moth defect — every
registration involved was accepted by the ledger, and no client-side change
(transaction construction, signing, proving) is implicated in any occurrence.
It is filed from Moth because Moth's users are the ones who keep hitting it on
local and shared devnets, and because Moth now ships detection and mitigation
for it (linked at the bottom) that upstream should be aware duplicates part of
what a real fix would make unnecessary.

---

## Title

`InvalidDustSpendProof` can become permanent and chain-wide after a DUST registration, with no way for a client to tell it apart from a transient race

## Environment

| Component | Version |
|---|---|
| midnight-node | `2.0.0-rc.4` |
| midnight-ledger | `9.1.0.0-rc.3` (vendored by the node above) |
| midnight-indexer | `4.4.0-pre-alpha.16-l91r3-n2r3-...` |
| proof-server | `9.0.0-rc.5_experimental` |

All four occurrences below were observed on local/self-hosted devnet stacks
running this exact component set.

## Summary

A NIGHT-for-DUST registration transaction is accepted by the node. Within
roughly 90 seconds, every subsequent DUST spend from **every wallet on the
chain** — including wallets that never touched the registered UTXO, including
the genesis wallet — is rejected:

```
1010: Invalid Transaction: Custom error: 170
```

The node log is more specific but not more actionable:

```
Transaction malformed: dust spend proof failed to verify; this is just as likely a disagreement
on dust state on the declared time (Timestamp(...)) as the proof being invalid: DustSpend { ... }
Rejected transaction ... : Transaction Error: Malformed(InvalidDustSpendProof)
```

Blocks continue to be produced on schedule. Nothing recovers the chain except
starting a new one. This has now been reproduced **four times**, independently,
across different chains, different client stacks (a browser wallet, a raw
`wallet-sdk` CLI harness), and different wallet implementations — ruling out a
client bug as the cause.

**This is the third distinct condition behind the client-visible `Custom error:
170` / `InvalidDustSpendProof` string**, and the only one that is *absorbing*
(nothing clears it short of a chain reset):

1. A node↔SDK ledger-tag pairing mismatch — deterministic, present from first
   deploy.
2. A transient race, roughly 1 attempt in 3, immediately after the same wallet
   has spent: the wallet's declared dust-state timestamp disagrees with the
   node's. **Retrying a freshly built transaction succeeds.**
3. **This report**: something about a DUST registration leaves the node's dust
   state unable to reconcile with *any* wallet's, permanently.

A client cannot distinguish (2) from (3) from the error alone — both produce
the byte-identical rejection.

## Why this matters more than a normal rejection

A retry loop written to handle (2) — the known, real, recoverable transient —
will spin forever against (3), and the operator gets no signal that the
**chain**, rather than the transaction, is what broke. Every occurrence below
involved multiple retries, from multiple wallets, across fresh processes,
before it was understood that retrying would never help.

## Evidence

### Occurrence 1 — first observed, 2026-09-01

A devnet that had been serving a live session for five hours stopped including
transactions entirely. From block **3116** (2026-09-01 18:36:00 UTC) onward —
170+ blocks, roughly 17 minutes, verified by querying every block in the range
through the indexer — the chain contained **zero** transactions, while blocks
continued to be produced on schedule.

Every submission after that point failed, from every wallet, regardless of
what it was:

| Attempt | Wallet | Result |
|---|---|---|
| contract deploy (15,462 B), ×6 | genesis | `1010: … Custom error: 170` |
| contract deploy, ×6 (fresh process each) | fresh probe wallet | `1010: … Custom error: 170` |
| plain 1-NIGHT transfer | genesis | `1010: … Custom error: 170` |
| plain 1-NIGHT transfer | fresh probe wallet | `1010: … Custom error: 170` |

The same genesis wallet had completed an identical-shape transfer **20 minutes
earlier**, and the same probe wallet had been funded and DUST-registered
successfully at 18:35–18:36 — those four transactions are the last four the
chain ever accepted. The rejected deploy declared `v_fee: 6853510813656816`
(≈6.9e15) against a wallet balance of 7.9e19 — four orders of magnitude of
headroom, growing throughout. This was not a fee-affordability problem.

The correlation available at this point: onset immediately followed two large
NIGHT UTXOs being newly registered for DUST generation, on a chain that had
also been under a sustained retry load (~6 rejections per 35s throughout).
Causality between either factor and the wedge was, at this point, untested.

Six retries with 12s backoff, then fresh processes, then a different wallet —
all failed identically. Only starting a fresh node cleared it: an identical
deploy, from an identical wallet, against the same image and code, succeeded
**on the first attempt** on a newly started chain.

### Occurrence 2 — 2026-09-02, sharper correlation

A fresh devnet wedged identically roughly 3.5 hours after genesis. The last
transaction the chain ever accepted was block **2289** (2026-09-02 01:34:18
UTC, tx `010060c3…`) — a **fee-less DUST registration**, a self-send of a
single 1,000,000-NIGHT UTXO whose only dust event was one `DustInitialUtxo`
(no `DustSpendProcessed`), submitted from a browser wallet (Moth).

The first rejection followed within **90 seconds** (01:35:46). From then on,
every dust spend from every wallet failed: four join attempts from the browser
wallet, and — decisively — a plain funding transfer from the **genesis
wallet**, via a CLI stack whose identical transfer had landed successfully at
01:17 on the same chain.

Registration is not sufficient on its own to trigger this — routine automated
funding flows on the same stacks register small wallets constantly without
incident — but two occurrences in a row now share the shape: a DUST
registration lands, and the chain stops reconciling anyone's dust state within
one to two minutes. Both times the immediately preceding write involved a
large, newly registered UTXO.

### Occurrence 3 — reproduced on demand; kills the "size" theory

On another fresh chain, a harness funded a fresh wallet with **300,000
NIGHT** and registered it. The registration landed, the wallet computed a
healthy DUST balance — and its very next spend, and **every other wallet's**
including genesis, failed `InvalidDustSpendProof` from that moment.

On the *next* fresh chain, the identical code registering **10,000,000 NIGHT**
(the same size used by every previously *successful* registration in this
environment) worked twice in a row, each proven by a post-registration spend.

So: the trigger is a DUST registration; wallet implementation is irrelevant
(a from-scratch CLI harness reproduces it as readily as a browser extension);
and UTXO size is **not monotonic** — 10,000,000 NIGHT is fine in some runs
while 300,000 and 1,000,000 have each killed a chain in others.

### Occurrence 4 — 2026-09-02, and the size theory is dead

A chain that had been healthy for roughly 90 minutes wedged the moment a
**10,000,000-NIGHT** registration landed — the same size as every previously
*successful* registration on this stack. The distinguishing variable this
time: the UTXO had been funded **39 minutes earlier**, by a provisioning run
that had stalled between funding and registering.

## The fund-to-register delay table

Every known outcome across all four occurrences, by size and delay:

| UTXO size | Fund → register delay | Outcome |
|---:|---:|---|
| 10,000,000 NIGHT | seconds | succeeded (10+ times) |
| 300,000 NIGHT | ~22 seconds | **wedged the chain** |
| 1,000,000 NIGHT | ~60 seconds (self-send) | **wedged the chain** |
| 10,000,000 NIGHT | 39 minutes | **wedged the chain** |

**Neither size nor delay alone explains this pattern.** The only rule with
zero observed failures across every occurrence is: *fund, then register
within seconds.* That is not a mechanism — it is the surviving correlation
after size was ruled out — and it is offered here as evidence, not as a
diagnosis this report is claiming to have made.

## Detection, for anyone else who hits this

Cheaper than reading the node log: ask the indexer whether any block in the
recent range contains a transaction.

```graphql
{
  block(offset: { height: N }) {
    height
    transactions {
      hash
    }
  }
}
```

A run of empty blocks spanning several minutes, on a chain that is otherwise
being written to, means the **chain** is wedged — not that any one submitted
transaction was malformed. This is the same check used to corroborate the
occurrences above, and the same one a client-side detector (linked below) uses
before concluding a wedge rather than a transient race.

## What we are asking for

1. **Distinguish "this proof is invalid" from "the node's dust state cannot be
   reconciled with any client's."** As it stands, `InvalidDustSpendProof` /
   client error 170 conflates at least three conditions of very different
   severity — a config mismatch, a retryable race, and unrecoverable chain
   corruption — and a client cannot tell them apart without reading the node's
   own log, which most clients (including every wallet SDK consumer) never
   see. A distinct error variant, or even a distinct field on the existing
   one, would let SDKs and wallets stop retrying the unrecoverable case
   immediately instead of burning the user's time on a loop that cannot
   succeed.
2. **A node whose dust state has diverged such that no wallet can pay a fee
   should say so once, at the node level, rather than silently rejecting every
   transaction individually forever.** A node-level health signal (a log line,
   a metric, an RPC field) that a devnet operator or a monitoring harness can
   check would turn "the chain silently stopped working an hour ago" into
   "the chain flagged its own dust-reconciliation failure at 01:35:46."

This supersedes nothing: the transient race in condition (2) is real, separate,
and already understood to be a client-visible-but-recoverable timing issue —
any fix for this report should keep that path retryable.

## Reproduction

A harness that isolates the fund-to-register delay as the one uncontrolled
variable, holding UTXO size fixed at the one size every known success used
(10,000,000 NIGHT), ships alongside this report:
`packages/cli/tests/integration/daemon/dust-wedge-repro.test.ts` in
[`shieldedtech/moth-wallet`](https://github.com/shieldedtech/moth-wallet). It
funds a fresh wallet, waits a configurable delay (`MOTH_TEST_WEDGE_WAIT_MS`,
default 90s; set to `2340000` for the exact 39-minute occurrence above),
registers, then attempts one spend from the freshly registered wallet and one
from genesis, and fails loudly — printing a full evidence report — only if
both spends show the `InvalidDustSpendProof` signature while the indexer
confirms blocks kept advancing. It has not (yet) reproduced the wedge on
demand within a short wait; the 39-minute case is the one worth running it
against.

## What Moth changed on the client side in the meantime

Because this is unfixed and absorbing, `shieldedtech/moth-wallet` ships
client-side mitigation that does not change any transaction's construction,
signing, or proving:

- **Detection**: a wallet whose dust spends are repeatedly rejected with this
  signature, while sync stays healthy, blocks keep advancing, and the
  wallet's own ledger version matches the network's, is told plainly that the
  network's dust ledger is wedged and needs a reset — instead of being left to
  retry forever against a generic failure
  (`packages/core/src/sync/dust-ledger-health.ts`).
- **UX**: the "Register for DUST" flow now warns before registering a NIGHT
  coin that has sat unregistered for more than a minute, and a wallet that has
  never registered is nudged to do so as soon as new NIGHT is observed —
  matching the only pattern with zero known failures above.

Neither of these is a fix. Both exist because retrying blindly, or registering
however the user happens to get to it, is actively dangerous on a devnet
carrying this defect, and upstream not yet having distinguished the three
conditions behind error 170 leaves a client with no other lever to pull.
