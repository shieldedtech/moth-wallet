# ADR 0003 — Pre-seed reference wallet (skipping the DUST chain walk)

- **Status:** Accepted and implemented on `feat/app-secret-and-send-to-name`. A pre-built reference now **ships in the extension package** for preprod (2026-08-10); on-device warming remains opt-in and off by default.
- **Verified:** a reference-seeded wallet can SPEND, not merely display — see "Does a copied tree spend?" below.
- **Date:** 2026-08-07
- **Related:** ADR 0004 (CI, storage and retrieval of references — the distribution question this ADR leaves open); `docs/spec/wallet-service/05-key-management.md` D-KM-3 (the reference wallet's mnemonic and its do-not-fund rule); `scripts/sync-benchmark.mjs` (the instrument every number here came from)

## Context

A brand-new empty wallet took **78.6 minutes** to sync against preprod. Not
because of transaction volume — the wallet had none — but because the DUST
sub-wallet streams every dust ledger event the chain has ever produced.

The wallet already had a mechanism meant to avoid this. `preSeedNewWallet` copies
a synced "empty reference" wallet's state into a new wallet with the keys swapped,
so it starts at chain tip instead of genesis. **It had never worked.**
`buildEmptyRefCache` started the reference and stopped it immediately;
`startWalletSync` returns on the first balance emission (or a 5s timeout), so
`stop()` serialized a wallet that had applied nothing. Every part was written with
`offset: 0`, which the SDK reads back as `appliedIndex: 0n` — its documented
"stream from genesis" sentinel (see `Sync.ts` in the SDK's dust-wallet package).

The pre-seed therefore reported `shielded + unshielded + dust at chain tip` while
seeding genesis, for as long as the cache had existed. On disk the reference was
**313 bytes at offset "0"**, months old. Shielded and unshielded hid the failure
because their genesis scan is cheap (~38s); dust made it visible as an hour.

Two facts established by reading the SDK source rather than assumed:

- **Dust ledger events are global.** The indexer streams `dustLedgerEvents` keyed
  by a global id, and `appliedIndex` advances to the last applied event id for
  *any* wallet, not only relevant ones (`makeDefaultSyncCapability`).
- **An empty wallet has no designations of its own.** So the reference's
  generation tree and cursor transfer to another wallet, with only the dust public
  key swapped.

A docblock in `preseed.ts` asserted the opposite — that dust "stores global
designation records that can't be swapped between wallets. It always syncs from
genesis." That comment was stale, contradicted by the implementation 40 lines
below it, and cost two wrong turns during this investigation, including an
unnecessary upstream request to the SDK team. It is now corrected.

## Decision

**Fix the reference build, and make paying for it an explicit act.**

- **The reference must reach chain tip before being serialized.** `waitForTip`
  blocks until `balances.synced`, with a 2h ceiling. An interrupted build persists
  partial state and the next attempt resumes from it.
- **Building is off the wallet-startup path.** `ensureEmptyRefCache` no longer
  builds by default — it returns a reference already at tip, or nothing. Building
  *is* the chain walk, so waiting for it during startup would block the user's own
  wallet for over an hour, which is worse than the bug. Deliberate builds go
  through `warmEmptyRefCache()`.
- **A usability gate, not a trust-the-sync check.** `loadUsableRefStates` requires
  a non-zero cursor on dust and shielded *and* a recorded height. An offset-0
  reference is never treated as warm again.
- **Pre-seed only when `reference.height <= wallet.birthday`.** See the safety
  section below — this is the most important line in the change.
- **Opt-in in the extension** (Settings → Network, "Speed up new accounts", off by
  default), with three states — Off / `Preparing N%` / `Ready` — because an
  hour-long job reported as a permanent "in progress" is indistinguishable from a
  stuck one.

## Measured results

Preprod, brand-new empty wallet, cold cache, via `scripts/sync-benchmark.mjs`.

| | before | after (warm reference) |
|---|---|---|
| unshielded synced | 3.4s | 47.8s |
| shielded synced | 38.6s | 49.2s |
| **dust synced** | **4715.8s** | **47.8s** |
| **total** | **78.6 min** | **49.2s**† |

> † **The 49.2s is unverifiable and should not be quoted.** It was produced by
> `sync-benchmark.mjs` before 10 Aug, when the script could not measure the seeded
> path in either mode — the measured wallet got an empty in-memory store so the
> reference was never found, and the birthday was read before warming so the guard
> refused it. Both modes silently reported the *unseeded* number. The shape was
> right and the conclusion holds, but the figure is not evidence. Re-measured
> 11 Aug with a fixed benchmark and a fresh reference: **29.3s**. See
> `docs/BENCHMARKING.md` for the current table.

- **99.2%** of a new wallet's sync was dust: 1,382,732 events at ~293 events/sec.
- **One-time reference build: 71.3 min** per network per machine. Produces a
  10.3 MB `dust.dat` (5.1 MB decoded) at offset 1,382,805, shielded 3.9 KB.
- **A warm on-disk reference is picked up in 0.02s.**
- **~47s of the remaining 49.2s is a single `DustLocalState.deserialize`** —
  measured in isolation at 48.76s, and confirmed in-situ by stage timings where
  every other startup stage was 0.0s. This is a per-launch floor for any
  fully-synced wallet, not a cost pre-seeding adds; it is also the cost behind the
  "Getting things ready" interstitial.

Chain rates, for reasoning about reference staleness: ~6.0 s/block, and dust
events accruing at ~46/hour recently against a ~420/hour lifetime average
(preprod is bursty — plan against the higher figure). Catch-up cost for a stale
reference, at ~293 events/sec:

| staleness | recent rate | lifetime average |
|---|---|---|
| 1 day | 4s | 34s |
| 1 week | 26s | 4 min |
| 1 month | 2 min | 17 min |

**Weekly refresh is sufficient; daily is generous.** Anything fresher is wasted
effort, because the ~47s deserialize floor dominates everything under roughly a
week of staleness.

## Safety: the height ≤ birthday rule

Making the pre-seed work turned a latent hazard live, and this is the part most
likely to be re-broken by someone who does not know why it is there.

The pre-seed condition is `(isNewWallet || birthday) && any seedable part missing`.
The extension passes `isNewWallet=false` and a `birthday` on **every** start, so
that condition admits any wallet merely *missing a cache* — a funded wallet after a
`syncCacheClear`, an IndexedDB eviction, or a restore from mnemonic. Seeding such
a wallet from a reference newer than its own first activity starts it **past its
own history**, dropping funds from view. Harmless while the reference sat at
offset 0 (seeding genesis is always safe); a real hazard once it carries a cursor.

Pre-seeding therefore requires `birthday !== undefined && reference.height <= birthday`.

**The units trap:** a snapshot's `offset` is a *dust event index* (1,382,805)
while `birthday` is a *block height* (1,977,245). They are not comparable, and
comparing them would be silently wrong in both directions. The height is recorded
separately (`emptyRefHeightKey`) and read *after* the sync completes, which can
only overstate it and therefore only make the check stricter. A reference with no
recorded height is unusable rather than guessed at.

Direction matters: a **stale** reference is only slower, because the wallet
applies everything from its cursor to tip. A reference **newer** than the wallet
is the dangerous case. Freshness is bounded on both sides.

Measured cost of staleness, so it is not guessed at. The same preprod reference,
at two ages (11 Aug):

| reference staleness | seeded total |
|---|---|
| 26 blocks | **29.3s** |
| 76,965 blocks | 117.5s |

About **half a second per hour of reference age**, against 78.6 min with no
reference at all. Staleness buys time, never correctness — and 29.3s is the floor,
being the cost of deserializing a 10.2 MB dust state with nothing to catch up on.

**Birthdays are per network** (`birthdays: Record<string, number>`), recorded on
first arrival at a network and never overwritten on return. A single value was
destroyed by every network switch, which left the wallet with no birthday at all —
and without one the guard can never pass, so a switched wallet walked from genesis
on every network for ever after. Recording is gated on an explicit `createdHere`
flag: an imported wallet may hold funds on any chain at any height, so it never
gets a birthday *automatically*.

**A user may assert one.** Moth cannot infer an imported seed's first-existence
height, but the person importing it often knows — the seed was generated minutes
ago, or in a month they can name, or funded by a transaction they can point at.
`wallet import` therefore accepts `--birthday-date`, `--birthday-height` and
`--birthday-tip`, and a date is resolved to a height by binary search over block
timestamps (~21 lookups on a 2M-block chain, so it runs inline).

This extends the rule rather than weakening it. `createdHere` still gates every
*automatic* birthday, including on a later network switch, so an assertion never
changes what Moth infers on its own. The failure modes stay asymmetric and the
rounding follows them: the search returns the last block strictly *before* the
target, because too early costs sync time and too late hides funds.

**The consequence of an over-late birthday differs by token type**, which the
height≤birthday rule alone does not convey. Unshielded coins are owned by an
address, so holdings are in principle discoverable by asking about that address.
Shielded coins are found only by trial-decrypting every output with the viewing
key — there is no query — so blocks skipped are coins that cannot be discovered
without rescanning from before them. Both cases are equally wrong; only the
unshielded one is noticeable. That is the argument for rounding early and for
saying so in the UI rather than only in the flag's help text.

The reference makes this workable at all: it carries an *empty* wallet's
serialised shielded, unshielded and DUST state at its height — including the
zswap state needed to build proofs onward — so a pre-seeded wallet has the local
information it needs rather than having to reconstruct it.

`createdAtHeight` is recorded separately for display — when the account was
created here — and is deliberately not consulted by the guard. Conflating the
two would let an informational value become a safety assertion.

**Seeding is per part.** The gate once tested the *shielded* cache alone as a
proxy for "no state yet". A DUST rebuild evicts only the dust cache, so shielded
was still present, the gate stayed shut, and dust walked from genesis with a
usable reference sitting untouched — making the narrow operation slower to
recover from than a full wipe. Each part is now seeded only where absent. Mixed
heights are coherent: the sub-wallets carry independent cursors, verified on
preview by rewinding dust to the reference (64,771) with shielded at tip (64,982)
and reaching synced in 1.0s with identical balances.

## Consequences

- New accounts created after a reference completes sync in seconds instead of an
  hour. Existing accounts are unaffected — they already have their own cache.
- Someone must absorb the 71-minute build. On-device it is per machine per
  network. Building it in CI and serving hash-pinned states is the better shape:
  the reference contains nothing user-specific or secret, so it is publishable —
  **but its mnemonic never is**, and a tampered reference can misrepresent
  balances (it cannot leak keys), so integrity must fail closed to a genesis sync.
- **This helps onboarding, not recovery.** A wallet that loses its cache cannot
  safely use a reference newer than its own history, so it pays the full walk
  again. Publishing *dated* references and selecting the newest with
  `height <= birthday` would fix that, and is not built.
- The reference grows the on-disk footprint (313 bytes → 10.3 MB per network).

## Does a copied tree spend?

The mechanism was proven to *sync* long before it was proven to *work*. Every
benchmark wallet held 0 NIGHT and 0 DUST, so no dust proof had ever been
exercised against a copied generation tree. If a copied tree could not satisfy
proving, the reference would be a display optimisation and nothing should have
been built on it.

Settled on preview, 2026-08-10, by `scripts/dust-proving-check.mjs`: a
reference-seeded wallet was funded, registered its NIGHT for DUST generation,
waited for DUST to accrue, and **built, proved and submitted a fee-paying
transaction**. DUST fell from 36,292,129,999 to 19,551,454,999 across
the run — the fee was paid, not merely accepted. Shipping references rests on
this result.

Corrected 2026-08-12: this paragraph said the run "waited out the ledger's 3h
grace period". The waiting happened; the reason given was wrong. `dust_grace_period`
is 3 hours, but it bounds how stale a transaction's declared `ctime` may be — it is
not a delay before generation begins. The wait was DUST accruing linearly from the
funding UTxO, which has no fixed duration and scales with the amount held. The
result this ADR rests on is unaffected. Kept as an annotation rather than a silent
edit, because this is a dated record of what was decided and on what evidence.

One caveat worth keeping: the check's first run reported FAIL at *submission*, and
its error handling blamed proving regardless of where the failure occurred. A
node-side failure says nothing about the copied tree. The script now reports which
stage failed and treats a submission failure as inconclusive.

## Where the bytes come from

A reference is public chain state — `preSeedNewWallet` swaps the new wallet's keys
in and keeps only `state`, `protocolVersion` and `offset` — so it can be shipped
already built rather than built on each device. Preprod's is bundled in the
extension package today (4.81 MB gzipped; `scripts/export-preseed.mjs` produces
it, `bundled-preseed.ts` loads it into IndexedDB on first sync).

**How references are built, stored and retrieved is ADR 0004's subject**, not this
one. What belongs here is the constraint that survives any distribution choice:
wherever the bytes come from, the `height <= birthday` and `createdHere` rules
above still decide whether a given wallet may use them, and a reference that
cannot be verified must fail closed to a genesis sync.

## Archived references (one reference per height)

A single live reference only ever serves wallets born *after* it. A reference is
the chain's state at one height, not a searchable record of the blocks below it,
so a wallet whose birthday precedes the reference must scan those blocks itself —
and that fallback is the whole cost the pre-seed exists to avoid. Measured on
preprod: an imported wallet with a date-derived birthday of 1,905,019 against a
reference at 2,104,384 silently fell back to genesis and had not finished DUST
(21%) at 2600s, where a wallet born at tip synced in 110.6s.

So each successful build is also archived under the height it reached:

- state: `sync/<network>/__empty_ref__@<height>/<part>` (sibling of the live slot)
- index: `empty-ref/<network>/archive.json` — the heights that exist, newest first

Selection, given a wallet's birthday: prefer the live reference when it is at or
below the birthday, else take the newest archived reference at or below it, else
scan from genesis. Only the live reference is memoised — an archived choice
belongs to one birthday, not to the network. `birthdayOutlook()` runs the same
selection ahead of an import, so the answer shown to the user is the one the sync
will actually take.

The safety rule is unchanged and still fails closed: a reference above the
birthday is never used, and an archive entry whose parts are missing from the
store is skipped rather than trusted.

Two writes keep the archive from losing ground:

- A build archives whatever the live slot held **before** advancing it. The build
  resumes the same reference wallet forward, so the older, lower height would
  otherwise be gone — and lower is what an earlier birthday needs.
- The extension's bundled reference is archived at its own height, and is no
  longer discarded when a locally built reference already holds the live slot.
  The bundle usually sits lower than a local build, so it covers birthdays the
  local one cannot.

### Surfaces

All three read the archive through core, over their own stores: `~/.moth/sync/
<network>/__empty_ref__@<height>/<part>.dat` on the CLI and TUI, opaque keys in
IndexedDB on the extension.

Seeing and building it was the gap. `moth preseed status` lists the heights held
and the earliest birthday that can skip the chain walk; `moth preseed build`
builds one at tip and archives it. The TUI's Network screen reports the same
figures read-only. Building stays off the TUI on purpose — it is a
tens-of-minutes sync, the same reason on-device warming is off by default.

### What this does not do

**It cannot build a reference at a height in the past.** Archives accumulate
going forward — a build today archives at today's tip. To serve a birthday from
last month, a reference must have existed at or below that height, which means
either an earlier build or the ability to stop a build at a chosen height.

Stopping at a height is not currently expressible. Sync progress is reported in
*event indices* (`appliedIndex` for shielded and DUST, `appliedId` for
unshielded), the indexer exposes no mapping from block height to any of them, and
the reference's height is recorded by reading the chain tip *after* the sync
finishes — which is an over-estimate, and therefore safe, only because the sync
ran to completion. Stopping mid-stream leaves no sound way to bound which blocks
the state covers, and a bound that is too generous silently skips a wallet's own
history.

Closing that gap needs one of:

1. an indexer query mapping a block height to the DUST event id at that height
   (DUST is the expensive part; shielded and unshielded are seconds either way), or
2. sync-to-height in the wallet SDK.

Until then the practical answer is cadence: build references regularly so the
archive is dense, which is why the CI cache carries `__empty_ref__*` and
`archive.json` rather than just the live slot.

**Distribution still ships one reference.** `export-preseed.mjs` and the workflow
artifact carry the live reference only. Publishing the archive would multiply the
artifact by the number of heights kept (~4.9 MB of DUST each) and needs a manifest
format that names heights — deferred, and the reason the archive is currently
useful mainly to a machine that builds its own references.

## Where a birthday comes from

Asking the user for a date was the weak point: it depends on memory, and a date
guessed too late hides funds with no symptom. The indexer indexes unshielded
transactions by address, so the first one can be read directly —
`unshieldedTransactions(address, transactionId: 0)`, take the first event.

Two things make it usable in practice. The progress event carries the highest
transaction id *for that address*, and it arrives first, so a value of 0 is the
definitive "never seen" signal — necessary because the subscription stays open
waiting for future transactions and never completes on its own. And a timeout or
an early close is treated as a failure, never as "no history": reading it as
empty would hand back the chain tip and skip the wallet's real history.

That also makes every assertion checkable. A birthday *above* a transaction the
indexer already holds is false by construction, so it is refused rather than
warned about, with `--birthday-force` as the deliberate override. An unreachable
indexer warns that the check did not run.

### The shielded gap

None of this covers shielded history, and the asymmetry is structural rather than
a gap in the implementation. Shielded coins are located by trial-decrypting every
output with a viewing key; there is no address for the indexer to index, and
`shieldedTransactions` needs a `connect(viewingKey)` session. No query can answer
"did this seed receive shielded funds before block N".

So a discovered birthday is correct for unshielded and unverified for shielded. If
shielded funds arrived earlier, the sync starts above them, the balance simply
looks smaller, and nothing reports an error — DUST generated by NIGHT that is not
visible is missing too. Clearing the sync cache rescans and recovers everything,
so nothing is destroyed, but until then the wallet understates what it holds.
Every surface states this where the choice is made, not only in documentation.

## Open

- **On-device warming stays off by default.** An hour of background chain traffic
  per network should be a deliberate choice. Only accounts created *after* a
  reference completes can use it, so warming cannot help the account whose
  creation prompted it — which is why the setting is not offered at account
  creation.
- **One unexplained measurement.** A run that built the reference in-process and
  measured immediately took 1052s where two independent fresh-process measurements
  say ~49s. The likely causes are heap/GC pressure from the 71-minute in-process
  sync, or a reference facade not fully torn down on `stop()`; they have not been
  distinguished. This bears directly on on-device warming, which is exactly that
  shape — and is a further argument for CI-built references.
- **No sync-state export/import.** The `.dat` caches cannot be backed up, moved
  between machines, or shared between the extension (IndexedDB) and CLI
  (`~/.moth`). The pieces exist — one `SyncStateStore` interface, and a
  serialization format the pre-seed already copies — but an export would be
  *sensitive*: the shielded snapshot is a decrypted view of balances and history.
