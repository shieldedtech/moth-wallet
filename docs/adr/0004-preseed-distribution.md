# ADR 0004 — Distributing pre-seed references (CI, storage, retrieval)

- **Status:** Proposed
- **Date:** 2026-08-10
- **Related:** ADR 0003 (the pre-seed mechanism, the `height <= birthday` guard, and why a reference is publishable); `scripts/export-preseed.mjs` (packaging); `packages/extension/lib/offscreen/bundled-preseed.ts` (the loader this would extend)

## Implementation status (2026-08-14)

The first phase of item 2 is implemented in
`.github/workflows/prepare-preseed.yml`: a manually dispatched run refreshes
preview and preprod from persistent public-state caches, exports checksummed
artifacts, and stops for human review. It does not publish, open, or merge a
change. The reviewed artifacts are promoted into a release candidate by a
separate signed commit.

The current extension candidate bundles both preview and preprod. This is an
interim packaging choice for the reference implementation, not a reversal of
item 3's longer-term direction. Mainnet remains the intended bundled default
once a mainnet reference has been built, validated, and accepted through the
governance process. Hosting non-default references remains an open follow-up.

## Context

ADR 0003 established that a pre-seed reference removes the DUST chain walk —
78.6 min to 103.1s on preprod — and that it is publishable: `preSeedNewWallet`
swaps the new wallet's keys in and keeps only `state`, `protocolVersion` and
`offset`, so a reference contains no user-specific or secret material.

Preprod's reference now ships **inside the extension package** (4.81 MB gzipped),
loaded into IndexedDB on first sync. The release candidate also bundles the
preview reference, solving the fresh-install case for both test networks while
leaving three problems:

1. **Only what existed at build time.** A network with no bundled reference gets
   the slow path until the user installs a new build. Mainnet — the default
   network for real users — has no reference at all today.
2. **Someone must build them.** 71.3 min per network per build, on a developer's
   machine, remembered by hand before a release.
3. ~~**There is no refresh path.**~~ **Resolved 11 Aug.** `ensureEmptyRefCache`
   short-circuits on a warm reference, so updating one appeared to require
   deleting it and rebuilding from genesis (53.6 min). That was never a
   limitation of the mechanism, only of the entry points: `buildEmptyRefCache`
   already resumes from whatever reference state the store holds.
   `refreshEmptyRefCache` bypasses the short-circuit — **measured at 9.1s to
   advance 25,660 blocks to zero stale**. Everything below that was gated on
   this is now unblocked.

Reference sizes measured 2026-08-10:

| network | raw | gzipped | build time |
|---|---|---|---|
| preprod | 10.26 MB | **4.83 MB** | 71.3 min |
| preview | 171 KB | **83 KB** | 96 s |

Size tracks chain length, so every network's reference grows over time and
mainnet's will be the largest.

## Decision

### 1. ~~Teach the reference to catch up~~ — done

`refreshEmptyRefCache(network)` starts from the existing state and syncs forward.
**9.1s to advance 25,660 blocks**, against 53.6 min to rebuild the same reference
from genesis.

It turned out to need about twenty lines, because `buildEmptyRefCache` already
restored from cached reference state — it syncs under `EMPTY_REF_WALLET`, and
`startWalletSync` restores that wallet's cache like any other. Only
`ensureEmptyRefCache`'s early return stood in the way. The premise this ADR was
written on ("there is no refresh path") was wrong, and expensively so: it
justified a full rebuild that need never have happened.

It also lets a **user's** stale local reference improve instead of being
discarded, and makes any refresh cadence affordable — refreshing before every
release now costs seconds.

### 2. CI builds references on a release cadence, not nightly

Nightly is over-engineering. Staleness costs **seconds of catch-up**, not
correctness (ADR 0003), so the difference between a nightly reference and one cut
per release is invisible to users. A nightly job would burn 71 min × N networks
every night to save a handful of seconds.

The first phase is a manually-dispatchable workflow that builds or refreshes the
preview and preprod references, runs `scripts/export-preseed.mjs`, records
checksums and uploads reviewable workflow artifacts. It deliberately does not
publish assets or modify the repository. Integrating those reviewed artifacts
into a release or PR remains a separate, human-approved step while the signing
and storage decisions below are unresolved.

CI needs persistent state for refresh to beat rebuild — a cache keyed by network
holding `sync/<net>/__empty_ref__/` and `empty-ref/<net>/height.txt`. The adjacent
`mnemonic.txt` is a secret and must never enter the cache or an artifact. Without
the public-state cache, refresh degrades to rebuild and the cadence argument
above applies with more force. With it, a refresh job is seconds, so cadence
stops being a cost question at all.

### 3. Storage: bundle the default network, host the rest

**Already settled for preprod, and recorded here rather than in ADR 0003 because
it is a distribution decision:** its reference is bundled in the package (4.81 MB
gzipped) rather than fetched. The freshness a runtime fetch would buy is worth
*seconds* (see the staleness measurement above), it would add a fetch that leaks
timing (see §4), and it would introduce a party who sets every new wallet's
initial state. Inside the signed package a reference is exactly as trustworthy as
the code that reads it.

That reasoning does not scale to every network, and neither pure option is right
in general.

**Bundling** costs package size per network and freezes the set at build time,
but has properties worth keeping: no new trust anchor, no network dependency, no
privacy exposure, and it is **self-healing** — if IndexedDB is evicted the package
copy is still there.

**Hosting** decouples the set of networks from the release cycle and keeps the
package small, but introduces a party who can set every new wallet's initial
state, and a fetch that reveals something about the user.

So:

- **Bundle the default network** (mainnet, once a reference exists). Most users
  never change network, and this keeps the common path offline and self-healing.
- **Host the others**, fetched on demand when a user first syncs a network with
  no local reference. A developer switching to preview has already accepted more
  exposure than a default-path user.
- Revisit when a single reference exceeds roughly **20 MB gzipped**, at which
  point bundling even one becomes disproportionate.

Location: a versioned, publicly readable object store. The manifest already
carries an S3 host permission
(`midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com`), so this needs
no new permission if that bucket is the home. GitHub Releases is the alternative
and is more auditable, but is awkward to fetch from a browser extension without
following redirects to a different origin.

### 4. Retrieval: signed, fail-closed, and not at account creation

Three rules, each with a specific failure in mind.

**Signed, with the public key in the extension.** A reference cannot leak keys,
but a tampered one can misrepresent balances by starting a wallet at a state that
omits its funds. Verification must **fail closed to a genesis sync** — slow is an
acceptable failure mode, wrong is not. A pinned hash is unsuitable because it
cannot change without an extension update, which defeats the purpose.

**Fetched at install/update or on network-add, never at account creation.**
Fetching when a wallet is created tells whoever hosts the file that a given IP
created a wallet on a given network at a given time. That is the moment least
worth leaking in a privacy wallet. Fetching when a network is *configured* leaks
only that the user configured it — which the indexer for that network already
knows the moment sync starts.

**The existing safety rules are unchanged and still decide usability.** A fetched
reference is subject to `reference.height <= birthday` and to `createdHere`
exactly as a bundled or locally built one is. Distribution changes where the
bytes come from, not who may use them.

## Would a user ever want to re-retrieve?

Four cases, and only one is a real yes.

**A network with no local reference — yes, the case worth building for.** Either
the network did not exist when the extension was built, or its reference was not
bundled. Today such a user pays the full walk indefinitely, with no way to fix it
short of an extension update. This is the mainnet situation right now, and it is
the strongest argument for hosting.

**IndexedDB eviction — yes, but bundling already answers it.** Chrome can evict
extension storage under pressure. A bundled reference is re-installed from the
package on the next sync at no cost; a hosted-only one would need re-fetching.
This is a point in favour of bundling the default network rather than hosting
everything.

**A fresher reference for the same network — marginal, and not worth a UI.** It
would only shorten catch-up for accounts created *after* the fetch, and the
saving is measured in seconds. Existing accounts have their own caches and are
unaffected. Refreshing opportunistically during an update is fine; prompting the
user is not.

**A DUST rebuild — no, not any more.** Since per-part seeding, "Rebuild records"
re-seeds from the reference already present (1.0s measured). A rebuild is
evidence the *wallet's* dust state was wrong, not the reference's.

One non-case worth stating because it looks like one: **a wallet restored from a
mnemonic can never use a reference**, fetched or otherwise. It has no birthday and
`createdHere` is false, because it may hold funds on any chain at any height. No
distribution mechanism changes that; only a per-height published series of
references would, and that is out of scope here.

## Consequences

- The set of networks with fast onboarding stops being fixed at build time, which
  is the point.
- A signing key enters the trust model. It cannot leak funds, but it can waste a
  user's time or misstate balances until sync corrects them, and it must be
  managed like any release key.
- CI gains a long-running, stateful job. Without a persistent cache and the
  refresh primitive it is 71 min per network per run, which will not survive
  contact with a release schedule.
- Two code paths for the same asset (bundled and fetched) need one loader and one
  verification story, or they will drift.

## Open

- **How reviewed CI artifacts enter a release.** The preparation workflow stops
  at checksummed artifacts; publishing or opening an asset-update PR remains a
  separate, human-approved action.
- **Who signs, and where the key lives.** Unresolved, and it gates hosting.
- **Whether mainnet's reference is even tractable to build in CI.** It is the
  longest chain and has never been built; 71.3 min is preprod's number, and
  mainnet's tip is already higher.
- **No sync-state export/import** (carried from ADR 0003). Users cannot move a
  reference between machines or between the extension and the CLI, so each
  installation pays its own way.
