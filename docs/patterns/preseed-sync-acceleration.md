# Pre-seeding: making a new Midnight wallet sync in seconds instead of an hour

A field guide for other wallet teams on the Midnight Network. It documents a
technique, the safety rules that make it safe, and the verification you should
insist on before trusting it — including the parts we got wrong first.

> **Read the safety section before implementing.** Pre-seeding done without the
> `height <= birthday` guard will silently hide users' funds. It is the single
> most important part of this document.

> **This is an interim technique, and deliberately so.** A light-client path is
> taking shape downstream: the dust spec's §"Wallet recovery" describes it,
> `midnight-ledger` 1.0.0 provides `MerkleTreeCollapsedUpdate` and
> `update_from_evidence`, and `midnight-indexer` exposes
> `dustCommitmentMerkleTreeUpdate` (4.1.0) plus `dustGenerationMerkleTreeUpdate`
> and `dustGenerations(dustAddress, …)` (4.2.0) — all still marked `@beta`.
> `@midnightntwrk/wallet-sdk` 1.2.0 does not currently consume them.
>
> That is the ordinary shape of a stack maturing from the bottom up, not a gap
> anyone left. For a wallet shipping today it means the light-client route is a
> roadmap item, and this is what works against the SDK you can actually depend on.
> See [what survives](#what-survives-the-sdk-catching-up) before building on it.

---

## The problem

A brand-new empty wallet on preprod took **78.6 minutes** to sync. Not because it
had transactions — it had none — but because of DUST.

| sub-wallet | time | share |
|---|---|---|
| unshielded | 3.4s | — |
| shielded | 38.6s | 0.8% |
| **dust** | **4,715.8s** | **99.2%** |

Dust walked 1,382,732 events at roughly 293 events/sec. Every new account paid
this, on every device.

The instinct is to look for a birthday or start-index to skip ahead. **There isn't
one.** All three sub-wallets expose only `startWithSeed` / `startWithSecretKeys`
(or `startWithPublicKey`) and `restore`; `DefaultSyncConfiguration` is just
`{ indexerClientConnection, batchUpdates }`. The indexer's subscriptions *do* take
resume cursors, but the wallet API does not surface them.

So `restore()` is the only way to begin anywhere but the beginning — which is
what this technique exploits.

---

## Why it works: dust ledger events are global

This is the load-bearing insight, and it is not obvious.

The indexer streams `dustLedgerEvents` keyed by a **global** id, and `appliedIndex`
advances to the last applied event id **for the chain**, not for your wallet. The
dust sub-wallet is not scanning "your dust" — it is building the chain-wide
generation tree, which it needs before it can say anything about dust at all.

Two consequences:

1. An empty wallet with no designations still walks all 1.4M events. Registering
   or not registering makes no difference.
2. **The tree is the same for everyone.** So an unfunded reference wallet's dust
   state transfers to any other wallet, once its keys are swapped.

An earlier version of our own docblock asserted the opposite — that dust "stores
global designation records that can't be swapped between wallets" — and that
wrong belief is why the optimisation went unbuilt for months.

---

## The mechanism

1. **Build a reference.** Generate a throwaway mnemonic, sync it to chain tip,
   serialize all three sub-wallet states. This costs one full chain walk, once
   per network per machine (53.6–71.3 min on preprod across two builds, 96s on
   preview).
2. **Record the chain height separately** at build time. You need it for the
   safety rule below, and you cannot derive it from the snapshot — see the units
   trap.
3. **Seed a new wallet** by parsing the reference snapshots, substituting the new
   wallet's public keys, and keeping `state`, `protocolVersion` and `offset`
   verbatim. For dust, only the public key changes: an empty wallet has no
   designations of its own, so there is nothing else that is wallet-specific.
4. **`restore()`** each sub-wallet from the swapped snapshot instead of
   `startWith*`. Sync then resumes from the reference's cursor.

The reference contains **no user-specific and no secret material** — it is public
chain state plus a key that gets replaced. That is what makes it publishable and
shippable.

> Its *mnemonic*, by contrast, must never be published, and the reference wallet
> must never be funded. We store it `0600` with a do-not-fund comment.

---

## Safety: the rules that stop this losing funds

### Rule 1 — `reference.height <= wallet.birthday`

Seeding a wallet from a reference **newer than its own first activity** starts it
past its own history. Its earlier coins are never scanned, and they silently
disappear from view.

This is harmless while the reference sits at offset 0 (seeding genesis is always
safe) and becomes a real hazard the moment the reference carries a cursor — which
is exactly when the optimisation starts working. **The bug and the feature arrive
together.**

A condition like `isNewWallet || birthday` is not sufficient. It admits any wallet
merely *missing a cache*: a funded wallet after a cache reset, a storage eviction,
or a restore from mnemonic. Require the height comparison explicitly.

Direction matters, and asymmetrically:

- a **stale** reference is only slower — the wallet applies everything from the
  cursor to tip;
- a **newer** reference is dangerous.

So freshness is bounded on one side only. Err old.

### Rule 2 — the units trap

A snapshot's `offset` is a **dust event index** (e.g. 1,382,805). A birthday is a
**block height** (e.g. 1,977,245). They are not comparable, and comparing them is
silently wrong in *both* directions.

Record the height separately at build time, and read it **after** the sync
completes — that can only overstate it, which only makes the check stricter. A
reference with no recorded height should be treated as unusable rather than
guessed at.

### Rule 3 — birthdays are per network

If you store one birthday per wallet, a network switch destroys it, and a wallet
with no birthday can never satisfy Rule 1 again. It will walk from genesis on
every network, for ever, no matter how many references you build.

Store `Record<networkId, height>`, recorded on **first arrival** at a network and
**never overwritten on return** — the wallet may have transacted there before
leaving, and a later tip would skip that history.

### Rule 4 — imported wallets never get a birthday

A wallet restored from a mnemonic may hold funds on any chain at any height. It
must scan from genesis; there is no safe shortcut.

Record this **explicitly**. Do not infer it from "has a birthday", because the
moment you split birthdays per network that signal dissolves. And when the flag is
absent on older records, read it as *imported* — being wrong that way costs a slow
sync, while being wrong the other way hides funds.

### Rule 5 — seed per sub-wallet, not all-or-nothing

Gate on the part you are about to seed, not on a proxy for "has any state".

We gated on the shielded cache. A DUST rebuild evicts only the dust cache, so
shielded was still present, the gate stayed shut, and dust walked from genesis
with a usable reference sitting untouched. The perverse result: **the more state
you destroyed, the faster you recovered** — a full wipe re-seeded in seconds while
the narrow, careful-looking repair cost 78 minutes.

Mixed heights are fine. The sub-wallets carry independent cursors, so dust can
restore at the reference's height while shielded and unshielded resume at tip.
Verified: dust rewound to 64,771 with shielded at 64,982 reached fully synced in
1.0s with identical balances.

---

## Verify that a seeded wallet can SPEND, not just sync

**Do not skip this.** For months our reference was proven to *sync* and never
tested against proving, because every benchmark wallet held 0 NIGHT and 0 DUST —
so no dust proof was ever exercised against a copied generation tree. If a copied
tree cannot satisfy proving, the whole thing is a display optimisation and you
have shipped a wallet that fails at its first transaction.

The test cannot be fully automated, for a structural reason: the account must be
funded **after** the reference height (seeding an already-funded wallet is refused
by Rule 1), and DUST has to accrue before anything can be spent. Ours is four
resumable steps — create seeded account → wait for NIGHT → register for DUST
generation → send a fee-paying transaction.

Two waits, not one, and they are easy to conflate. Registration itself has to wait:
it self-funds from the DUST its NIGHT would already have generated, so a thinly
funded account cannot even register for hours. Fund the check account generously
and both waits shrink to seconds. See
[the registration bootstrap](./midnight-wallet-characteristics.md#the-registration-bootstrap-and-the-trap-in-it).

Result, on preview: building, proving and submission all succeeded against a
copied tree, with DUST falling 36,292,129,999 → 19,551,454,999 across the run.
**The fee was paid, not merely accepted.**

One trap in the test harness itself: our first run reported FAIL, and its error
handling blamed proving regardless of where the failure occurred. It had actually
failed at *submission* — a node-side problem that says nothing about the copied
tree. Make your harness report **which stage** failed, or it will condemn the
mechanism on bad evidence.

---

## Measured results

Preprod, unless noted. Absolute numbers drift with indexer load; the ratios are
the durable part.

| scenario | time |
|---|---|
| new wallet, no reference | **78.6 min** |
| new wallet, fresh reference (26 blocks stale) | **29.3s** |
| new wallet, reference 76,965 blocks stale | 117.5s |
| building the reference (one-off, per network, per machine) | 53.6–71.3 min |
| warm reference lookup | 0.02s |
| DUST rebuild, re-seeded | 1.0s |
| *preview:* no reference / seeded / build | 103.3s / **8.7s** / 96.0s |

Reference sizes: preprod 10.26 MB raw, **4.83 MB gzipped**; preview 171 KB / 83 KB.
Size tracks chain length, so it grows and mainnet's will be largest.

**Staleness costs time, not correctness.** The same preprod reference cost 29.3s
at 26 blocks stale and 117.5s at 76,965 — about **half a second per hour of
reference age**. That is what makes shipping a pre-built reference viable: it is
stale by definition the moment it reaches a user, and one cut at release is still
under two minutes of catch-up a month later.

**Batch tuning is not the lever**, in case it looks like one. Quadrupling batch
size and removing spacing moved a preview run 8.7s → 8.5s; pre-seeding moved it
103.3s → 8.7s.

---

## Distribution

The reference is publishable, so it need not be built on each device.

**Bundling it in the signed package** adds no trust anchor, needs no network
call, and is self-healing if local storage is evicted. It costs package size per
network and freezes the set at build time.

**Hosting it** decouples networks from the release cycle, but introduces a party
who can set every new wallet's initial state, and a fetch that leaks *when* a user
created a wallet on *which* network — the moment least worth leaking in a privacy
wallet. If you host: sign it with a key pinned in the client, **fail closed to a
genesis sync** on any verification failure, and fetch on network-add rather than
at account creation.

Either way, Rules 1–5 still decide who may use it. Distribution changes where the
bytes come from, not who may use them.

---

## Pitfalls we hit

- **Serializing a reference too early.** `startWalletSync` resolving on the first
  balance emission is not "synced". We stopped the reference immediately after
  start, wrote every snapshot at offset 0, and the SDK read that back as its
  *stream-from-genesis sentinel* — so the pre-seed reported "at chain tip" while
  seeding genesis, for months. Assert the recorded height and a non-zero dust
  offset before treating a reference as usable.
- **Benchmarks that cannot measure the thing.** Ours handed the measured wallet an
  empty in-memory store (so the reference was never found) and read the birthday
  *before* warming (so Rule 1 refused it). Both modes silently reported the
  unseeded number. Make your benchmark print which path it took, and check for it.
- **Measuring in the process that just built the reference.** One such run took
  1052s where two independent fresh-process runs said ~49s. Cause never
  established — heap pressure, or a facade not fully torn down. Build in one
  process, measure in another.
- **Projecting from a prefix.** An early four-minute window suggested 419
  events/sec; the full run averaged 293. Rates decay.

---

## What survives the SDK catching up

When the SDK can build dust state from collapsed updates, this technique stops
being worth doing. Plan for that now, because the three layers have very
different lifespans.

**The safety rules survive unchanged.** `height <= birthday`, per-network
birthdays, `createdHere`, per-part seeding. These are not SDK-shaped — they are
statements about when it is safe to start a wallet somewhere other than genesis,
and a sparse-state client needs exactly the same guards for exactly the same
reason. This is most of the thinking on this page and none of it is throwaway.

**The distribution machinery survives.** Packaging, refreshing, benchmarking and
the spend verification are all about getting bytes to a wallet and proving the
result. Orthogonal to how the wallet consumes them.

**The snapshot format does not.** Key-swapping a serialized sub-wallet state
depends on a shape that is not a public contract, and a sparse-state SDK release
is likely to change it. That is a clean retirement rather than a migration: you
stop shipping the reference and delete the loader. Nothing accumulates that has to
be unwound.

Watch for a wallet-SDK release that consumes the indexer's collapsed-update
endpoints, and for those endpoints leaving `@beta`. Either is the signal to
re-evaluate; both together are the signal to retire this.

The failure mode in between is benign, provided you fail closed: an unparseable
or height-less reference falls back to a normal sync, so an SDK bump that changes
the format costs time, never correctness.

## Version risk, stated plainly

This technique depends on the **shape of the SDK's serialized sub-wallet state** —
that a snapshot is JSON with `publicKeys`/`publicKey`, `state`, `protocolVersion`
and `offset`, and that swapping the key fields leaves the rest valid. That is not
a documented public contract, and it can change between SDK releases.

Guard accordingly: treat a reference that fails to parse, or lacks a recorded
height, as unusable and fall back to a normal sync. A slow wallet is an acceptable
failure mode. A wallet that starts past its own history is not.

Measurements here were taken against `wallet-sdk@1.2.x` / `ledger-v8@8.1.0` in
August 2026.

---

## Reference implementation

- `packages/core/src/sync/preseed.ts` — building, loading and key-swapping
- `packages/core/src/sync/preseed-parts.ts` — the per-part seeding decision
- `packages/core/src/wallet/manager.ts` — per-network birthdays and `createdHere`
- `packages/extension/lib/offscreen/bundled-preseed.ts` — loading a packaged reference
- `scripts/sync-benchmark.mjs` — the instrument every number here came from
- `scripts/dust-proving-check.mjs` — the spend verification
- `docs/adr/0003-preseed-reference.md` — the decision and its safety rules
- `docs/adr/0004-preseed-distribution.md` — CI, storage and retrieval (proposed)
