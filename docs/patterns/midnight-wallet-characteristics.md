# Midnight wallets: what's familiar, what isn't

An orientation for anyone arriving from Zcash, Monero, or general ZK-wallet
experience. Where the intuitions transfer, where they mislead, and why the fix
that works *today* is not the fix the protocol intends.

Companion to [pre-seeding](./preseed-sync-acceleration.md), which is the
implementation.

---

## The shared inheritance

Midnight's shielded side is recognisably **Zcash Sapling/Orchard**. Commitments
and nullifiers, a global commitment tree, trial decryption against a viewing key,
ephemeral keys and ECDH. If you have built a Zcash light wallet, that half will
feel like home. **Zswap** is Midnight's version of that layer, and the family
resemblance is deliberate.

It shares Zcash's central awkwardness too: the chain cannot tell you your
balance, because it does not know which notes are yours. You have to look at
everything and try.

Where it parts company with **Monero** is the anonymity model. Monero hides the
sender in a ring of decoys and derives one-time addresses per output; every
wallet scans every output testing key derivation. Midnight does not use ring
signatures — it is commitment/nullifier, like Zcash. The *scanning burden*
rhymes; the cryptography does not.

---

## Where the resemblance stops being useful

On Midnight, **the shielded scan is not the expensive part.**

A brand-new empty wallet on preprod took 78.6 minutes to sync:

| | time | share |
|---|---|---|
| unshielded | 3.4s | — |
| shielded — the Zcash-shaped part | 38.6s | 0.8% |
| **DUST** | **4,715.8s** | **99.2%** |

All the Zcash intuition points at trial decryption. Trial decryption costs
**thirty-nine seconds**. The other seventy-eight minutes are something Zcash and
Monero do not have at all.

---

## DUST is the genuinely new thing

Midnight has two tokens with unrelated mechanics. **NIGHT** is what you hold.
**DUST** is what pays fees — and you do not receive or transfer it. You *generate*
it by registering NIGHT you hold, and it accrues toward a cap over days.

The consequence for a wallet is structural: DUST's generation records are **global
chain state**, not per-wallet notes. The indexer streams `dustLedgerEvents` keyed
by a chain-wide id, and the wallet must build the entire generation tree before it
can say anything about your dust — *even if you have none, even if you have
registered nothing.*

That breaks the *birth-height* bargain specifically. In Zcash, a birth height
works because a note encrypted to your key cannot predate your key. That reasoning
is airtight — and it does not apply to a cumulative global tree. You cannot start
halfway through and have a correct tree.

It does **not** break light clients in general. What a wallet needs is a *path* to
its own commitments, not the tree — and the protocol has a design for exactly
that. See below.

---

## What that costs you, architecturally

**A birth height does not rescue you.** The wallet SDK exposes no start-index at
all — `startWithSeed`, `startWithSecretKeys`, `restore`, and nothing else. The
indexer's subscriptions do take resume cursors, but they are event-space ids
(`index`, `id`, `transactionId`), not block heights — and a cursor resumes a
*stream* while a tree needs *state*. Even with one, the ceiling is 0.8% of the
wait.

**A light-client path exists, and the wallet SDK does not currently consume it.**
This is the most important thing on this page. It is a statement about where the
stack is in its development, not a criticism: the pieces landed downstream first,
which is the normal order, and the SDK is the layer that has yet to catch up.

The dust spec's §"Wallet recovery" prescribes a light-client path: dust
commitments are deterministically chained from your own Night UTXOs
(`nonce = hash(initial_nonce, seq_no, sk)`), so a wallet can compute its own
commitments and look them up rather than walking the chain. It even anticipates
the privacy objection, with a tunable answer — query by *bit prefix* so the
indexing service sees an anonymity set rather than your exact commitment.

The pieces, and the versions they arrived in:

| layer | what it provides | version |
|---|---|---|
| dust spec, §Wallet recovery | prefix queries over chained commitments | current |
| `midnight-ledger` | `MerkleTreeCollapsedUpdate`, `update_from_evidence` | 1.0.0 |
| `midnight-indexer` | `dustCommitmentMerkleTreeUpdate` | **4.1.0**, `@beta` |
| `midnight-indexer` | `dustGenerationMerkleTreeUpdate`, `dustGenerations(dustAddress, …)` | **4.2.0**, `@beta` |
| `@midnightntwrk/wallet-sdk` | full-tree sync | **1.2.0** — does not currently consume the above |

The indexer's schema names the intended caller directly: *"Wallets deserialise
this and hand it to `generating_tree.update_from_evidence(...)`."*

So the 78 minutes is neither a protocol constraint nor an indexer gap. The
capability lands at the SDK layer when the SDK adopts it, and those endpoints are
still `@beta` — for a wallet shipping today, this is a roadmap item rather than an
available option.

**Which makes state transplanting an interim measure, not the answer.** Sync one
empty reference wallet to tip and hand its serialized tree to every new wallet
with the keys swapped: 78.6 minutes becomes 29.3 seconds, today, against the SDK
you can actually ship. It works precisely *because* the tree is global — the thing
that makes DUST expensive is the same thing that makes it shareable.

Treat it as a bridge with a visible far bank. Once a wallet SDK release consumes
the collapsed-update endpoints, shipping a 10 MB tree stops being worth doing and
the transplant retires rather than migrating. See
[pre-seeding](./preseed-sync-acceleration.md) for what survives that transition
and what does not.

---

## Where the familiar dangers come back

The moment you transplant state, you inherit every restore-height hazard the
Zcash world already knows, in a sharper form.

Seed a wallet from a snapshot **newer than its own first activity** and it starts
past its own history. Its earlier coins are never scanned and silently vanish. No
error — just a smaller balance.

There is a trap peculiar to this design: **the bug and the feature arrive
together.** While the snapshot sat at offset zero it was harmless, because seeding
genesis is always safe. It became dangerous at the exact moment it started
working.

The other rule transfers unchanged from Zcash, where wallets learned it the hard
way: **a wallet restored from a mnemonic can never be given a birth height.** It
may hold funds on any chain at any height. Asking the user to guess — as most
restore-height UIs do — is asking them to lose money quietly. Refuse it and eat
the full scan.

---

## Also unlike Zcash and Monero

- **Fees require a separate, earned resource.** A funded wallet with no registered
  NIGHT cannot transact at all until DUST accrues. "Has balance" and "can spend"
  are genuinely different states, and a wallet has to say so.
- **You cannot even register without waiting, and the wait scales with your
  balance.** This is the one that surprises everyone, including us — see below.
- **Registration is itself a transaction**, so the balance dips while it is in
  flight: the SDK books the NIGHT inputs, and a naive read shows zero. Displayed
  balance has to count booked inputs or it lies during the one operation every new
  user must perform.
- **Sync and submission use different services.** The indexer drives all sync; the
  node is only reached to broadcast. A node outage leaves balances perfectly
  correct while sending is impossible — which is not a state most wallet UIs are
  built to express, and it is worth expressing.
- **Three sub-wallets, independent cursors.** Shielded, unshielded and dust each
  resume separately. That is what makes partial state transplants coherent, and it
  means "synced" is a conjunction rather than a single number. Progress reported
  from any one of them will be wrong; report the slowest.

---

## The registration bootstrap, and the trap in it

DUST pays fees. Registering NIGHT is how you get DUST. So what pays for the
registration?

The protocol has a real answer, and it is a good one. A `DustRegistration`
carries an `allow_fee_payment` field, and the ledger lets the transaction pay its
own fee out of the DUST its NIGHT *would have* generated had it been registered
all along — effectively backdating the registration. From the dust spec:

> because registrations run a challenge of paying for their own fees, if the same
> Night address is used in a registration, and at least one input that is *not*
> backing any Dust, then fees may be taken from the Dust these inputs *would
> have* generated

So a wallet holding no DUST at all can register. No deadlock.

**But self-funding is not free.** `generationless_fee_availability` caps the
backdated amount at

```
elapsed_since_the_utxo_was_created  ×  night_value  ×  generation_decay_rate
```

which starts at **zero** and grows. Three consequences a wallet has to handle:

1. **The wait is inversely proportional to your balance.** At the ledger's
   defaults (5 DUST per NIGHT, ~1 week to cap) a 0.3 DUST registration fee needs
   roughly **36 s at 1,000 NIGHT, 6 min at 100, an hour at 10, and 10 hours at
   1.** A faucet drip is the *worst* case. Telling a user "get more NIGHT" is
   better advice than "wait".
2. **Only NIGHT not already backing DUST counts** — the ledger's
   `!night_indices.contains_key(initial_nonce)` filter. So deregistration cannot
   self-fund at all: its inputs are all registered, backdated availability is
   zero, and it must pay with real DUST. Our code shows the asymmetry directly —
   `designateForDust` never balances, `dedesignateFromDust` does.
3. **The NIGHT must be spent as an input in the same transaction**, since the
   ledger reads `guaranteed_unshielded_offer.inputs`. That is why registration
   books the UTxOs, and why a naive balance read shows zero mid-flight.

### Where this bit us

We recorded, in this document, that "the ledger imposes a grace period (3h on the
networks we measured) before any DUST appears." **That was wrong**, and it is
instructive about how it was wrong.

`dust_grace_period` is 3 hours, so the number was real. But it is the validity
window for a transaction's declared `ctime` relative to block time — how far out
of date a transaction may be and still be accepted — **not** a delay before
generation starts. Generation is linear from the UTxO's creation, with a
time-to-cap of about a week.

What we had actually observed was a fresh wallet unable to register for hours. We
found a 3-hour constant in the ledger, and it matched. The real cause was
fee-coverage accrual on a thinly funded wallet, which has no fixed duration at
all — it depends on how much NIGHT you hold. A plausible mechanism that predicts
the observation is not the same as the right one, and here the difference changes
the advice you give the user.

---

## The short version

Midnight's shielded layer is Zcash with the serial numbers filed off, and the
intuitions transfer. Its fee layer is unlike anything in Zcash or Monero: it
accounts for 99% of sync time, and it gates a new wallet's first action behind an
accrual whose duration depends on how much NIGHT that wallet holds. But it is
**not** immune to light-client techniques. The spec prescribes one, the ledger (1.0.0) and indexer (4.1.0–4.2.0,
`@beta`) implement the pieces, and the wallet SDK (1.2.0) does not currently
consume them.

The optimisation that works *today* is not a light-client technique at all. It is
closer to shipping a database snapshot — and the safety rules around it look far
more like ordinary state-migration discipline than cryptography. Those rules
survive the transition to a proper light client; the snapshot does not, and is
meant to be retired rather than migrated.

---

## Evidence

Every figure here was measured, not estimated. Method, instruments and the full
result set: [`docs/BENCHMARKING.md`](../BENCHMARKING.md). The mechanism and its
safety rules: [pre-seeding](./preseed-sync-acceleration.md) and
[ADR 0003](../adr/0003-preseed-reference.md).
