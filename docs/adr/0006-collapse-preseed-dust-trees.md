# ADR 0006 — Collapsing the DUST trees in pre-seed references

- **Status:** Proposed
- **Date:** 2026-09-15
- **Related:** ADR 0003 (the pre-seed mechanism, and the deserialize "floor" it measured); ADR 0004 (distribution, and the CI workflow that now verifies the collapse); ADR 0005 (the CLI `preseed` commands); `packages/core/src/sync/dust-reference-collapse.ts` (the transform and its checks); `scripts/collapse-preseed.mjs` (the bundle tool CI runs)

## Context

A wallet seeded from a pre-seed reference inherits the reference's dust state.
`startWalletSync` (`packages/core/src/sync/wallet-sync.ts`) restores that state
with one `DustLocalState.deserialize` every time the wallet starts: every launch
or unlock, in the CLI, the TUI and the extension alike. All three go through that
one call, so whatever it costs, every surface pays.

On preprod the reference's dust state was **5,474,535 bytes**, and deserializing
it took **~57s** in Node on a developer laptop. Earlier measurements in this
repository put the same step at 46.7–48.8s (ADR 0003, `docs/BENCHMARKING.md`), and
one measurement in the extension came in at ~38s. Whichever figure is taken, it
was most of a seeded wallet's start-up, and it was paid on every launch rather
than once. ADR 0003 recorded it as "a per-launch floor for any fully-synced
wallet, not a cost pre-seeding adds". The second half of that holds. The first
half did not: the floor was mostly a ledger defect.

Nearly all of those bytes are the DUST generation Merkle tree, and most of the
tree should not be there. ledger-v8 8.1.x mishandles that tree during replay. It
collapses each generation the wallet does not own as the generation is applied,
but a later dtime update that lands on an already-collapsed leaf re-expands it,
and nothing collapses it again. The expanded and collapsed shapes hash to the
same root, so the defect costs space and time and nothing else. That is also why
it went unnoticed: every check that compares roots passes.

Two version facts, given as context. Neither is part of this decision:

- ledger-v8 **8.1.2**, the latest 8.x release, still takes ~57s on the same state.
- ledger-v9 **1.0.0-rc.5** deserializes the same bloated state in ~1.2s. It is a
  release candidate, and this change does not upgrade the ledger.

The constraints that narrow the options:

- **Only a wallet that owns no DUST can be collapsed safely.** On 8.1.x, reading a
  collapsed leaf the wallet owns panics rather than failing cleanly. The reference
  owns nothing by construction (its do-not-fund rule, ADR 0003).
- **References reach wallets by several routes.** They are built or refreshed on
  the device (`moth preseed build` / `refresh`, the extension's "Speed up new
  accounts"), imported (`moth preseed import`), bundled in the extension, and
  prepared in CI. Some are already stored on users' machines, and the extension
  never overwrote a stored reference.
- **8.1.x has no getter for a tree's first free index**, which is the number a
  collapse of "the populated range" needs.

## Decision

**We will collapse the populated range of the generation and commitment trees in
every reference's dust state, at every point a reference is written or handed
out, and verify the result before anything uses it.**

### The transform

`collapseDustReference` collapses each tree from index 0 to one below its first
free index. Before returning, it checks that:

- the roots, balance, UTXO count and sync time are unchanged;
- the collapsed state survives serialize → deserialize with the same values and
  the same frontiers;
- appending the next leaf at each frontier gives the same root on the original and
  the collapsed state, which is exactly what later sync does to it;
- the rewritten snapshot envelope differs from the input only in `state`.

It throws rather than return anything it could not check. It refuses a snapshot
holding DUST UTXOs instead of trusting its caller. It is idempotent: an
already-collapsed snapshot comes back byte-for-byte.

`treeFrontier` reads a tree's first free index. With no getter on 8.1.x, it
attempts an insert at index 0 and reads the index out of the ledger's
non-linear-insert refusal ("expected to insert index N"). That is an error message
standing in for an API, and this decision accepts it knowingly. The workaround is
contained in one function and pinned by a test that says it is a workaround. It
prefers ledger-v9's `generatingTreeFirstFree` / `commitmentTreeFirstFree`
properties whenever the loaded ledger has them. A misread frontier fails the
checks above rather than being used.

### Where it runs

| where | what reaches it | if the collapse fails |
|---|---|---|
| `buildEmptyRefCache` | a build or refresh that reached tip: `moth preseed build` / `refresh`, the extension's "Speed up new accounts", the CI prepare workflow | the stored state is kept as it is |
| `ensureEmptyRefCache` | a stored reference being handed out to seed a wallet: a one-time collapse of references stored by earlier versions, recorded by `empty-ref/<network>/dust-collapsed.txt`, which holds the dust cursor | the stored state is handed out as it is |
| `importReference` | `moth preseed import`, which reports `dust: 'collapsed' \| 'already-collapsed' \| 'as-is'` | stored as given (`as-is`) |
| `exportReference` | `moth preseed export` | exported as stored |
| `scripts/export-preseed.mjs` | cutting the extension's bundles | **the export is refused**; `--no-collapse` cuts an uncollapsed comparison artifact |

**Fatal at export, best-effort at runtime.** A bundle is an artifact we control
and can re-cut, so refusing one costs a re-run. On a user's machine an
uncollapsed state is still correct, only slower, so refusing it would trade a
slow launch for no reference at all. This is the same asymmetry ADR 0004's
2026-08-21 addendum draws for witnesses.

The collapse applies to the **reference only**. A wallet's own dust state is
never collapsed.

### Around it

- **`scripts/collapse-preseed.mjs`** collapses a bundle directory: every bundle the
  extension ships by default, one with `--network <id>`, or any directory with
  `--dir <bundle-dir>`. `--check` verifies without writing and fails on an
  uncollapsed or invalid bundle; `--json` prints a machine-readable report. Its
  checks (`scripts/lib/collapse-preseed.mjs`) all run before anything is written:
  the manifest's network, height and both witnesses; all parts present and
  gzipped JSON; the manifest recording the files it ships; a usable cursor; core's
  verified collapse; and the exact compressed bytes reading back to the same
  roots, no UTXOs and the same cursor. Writes go to a temporary file and are
  renamed into place.
- **CI guards the bundles.** `ci.yml` runs `collapse-preseed.mjs --check` in the
  `test` job, and `cd.yml` runs it before building the extension ZIP. The prepare
  workflow runs it against the exported artifact, then the test suite, then the
  CLI end-to-end test against that artifact, and only then records checksums and
  uploads.
- **The extension retains references assigned to existing wallets.** Before
  installing a newer bundle it migrates the previous reference and pins eligible
  wallets to its content hash, separately for each network. New wallets choose
  the newest birthday-compatible reference. A recovery checks witnesses again;
  an invalid reference cannot bypass the birthday guard or skip chain history.
  Parts, witnesses, versions and assignments publish in one IndexedDB transaction.
  Unassigned versions are collected, retaining the newest version for future wallets.
- **DUST-only recovery can use a newer reference after a history check.** If no
  birthday-compatible version is available, the extension can offer a fully
  witnessed candidate to core. Only a completed indexer query showing no owned
  DUST generation history before that reference permits DUST seeding. Shielded
  and unshielded retain their birthday gate; the candidate does not replace a
  wallet assignment or make imported wallets eligible to contribute snapshots.
- **Preparation runs in a separate worker.** “Speed up new accounts” can refresh
  from an existing reference without replacing assignments. An interrupted build
  restarts from the retained verified version; incomplete working files never
  become published references. Reset epochs prevent late workers from undoing a reset.
- **A newly generated wallet can contribute its first completed sync.** Core
  captures all three serialized parts from the same fully synced emission before
  notifying consumers. The host sends immutable strings, without secret keys,
  to a separate worker. It rejects any ownership or pending records, replaces
  public identities with a throwaway identity, collapses and checks DUST trees,
  captures cursor witnesses, and publishes a new version for future wallets.
  The current wallet keeps its original assignment and live state. Imported or
  resumed wallets do not contribute: independently saved partial caches cannot
  establish the provenance required for a new reference.
- **The preview and preprod bundles are re-cut and collapsed** in this change:
  preprod rebuilt from genesis, because its old cursors no longer match the
  indexer, and preview refreshed to tip from its previous bundle, whose witnesses
  still matched. The preprod renumbering that forced the re-cut, and the removal of the
  qanet bundle, are recorded in ADR 0004's 2026-09-15 addendum.

## Alternatives considered

### Option A — Collapse at every write and hand-out point, verified

- **Summary:** as above.
- **Pros:** every surface benefits, including CLI-built references and references
  already stored on users' machines. One transform and one set of checks serve
  every call site. Works against the ledger the wallet ships today.
- **Cons:** depends on an error-message workaround on 8.1.x. Five call sites
  rather than one. A one-time collapse cost for previously stored references.
- **Why chosen:** it is the only option that removes the per-launch cost wherever a
  reference-seeded wallet starts, without a ledger upgrade.

### Option B — Wait for ledger-v9

- **Summary:** ledger-v9 fixes the re-expansion, and restores the same bloated
  state in ~1.2s.
- **Pros:** no workaround. It also helps wallets that own DUST, which the collapse
  cannot.
- **Cons:** 1.0.0-rc.5 is a release candidate. A ledger major is a large change to
  take on for one symptom. Until it ships, every seeded wallet keeps paying ~57s
  per launch, and ~1.2s is still well above the ~7 ms a collapsed state takes.
- **Why not chosen:** a release candidate is not something to ship on, and the two
  are not exclusive: `treeFrontier` already prefers ledger-v9's properties when
  they are present.

### Option C — Collapse only the shipped bundles

- **Summary:** what the proof of concept did. Rewrite the extension's
  `dust.dat.gz` files and nothing else.
- **Pros:** one place to change, and no runtime code.
- **Cons:** misses every reference built by `moth preseed build` / `refresh` or the
  extension's on-device build, and every reference already stored by an existing
  install.
- **Why not chosen:** it fixes fresh installs of the extension and nothing else.

### Option D — Also collapse wallets that own DUST

- **Summary:** extend the collapse to a user's own dust state, so funded wallets
  benefit too.
- **Pros:** would reach the wallets this decision leaves slow.
- **Cons:** unsafe on 8.1.x, where reading a collapsed owned leaf panics. The API
  also does not expose which generation indices a wallet owns, so the owned leaves
  cannot be kept out of the collapsed range.
- **Why not chosen:** it cannot be done safely against this ledger. ledger-v9 is
  the path for funded wallets.

## Consequences

### Positive

- **Preprod:** reference dust state 5,474,535 → 3,666 bytes; deserialize ~57s →
  ~7 ms.
- **Preview:** 131,427 → 3,564 bytes; 65 ms → 7 ms.
- **Shipped preprod `dust.dat.gz`:** 5,139,554 B → a few KB. The package-size cost
  that ADR 0004 §3 weighed against bundling is now negligible.
- The CLI, TUI and extension all benefit from one change, because they all restore
  through `startWalletSync`.
- The bundles are guarded. CI refuses an uncollapsed or invalid committed bundle,
  and the prepare workflow will not upload one.

### Negative

- **An error message stands in for an API.** On 8.1.x `treeFrontier` depends on
  the wording "expected to insert index N". A ledger that rewords it fails the
  pinned test. At runtime it fails the collapse, so the reference is used as it
  is, rather than misreading the frontier. The workaround retires with ledger-v9's
  first-free properties.
- **The state regrows as it syncs.** The defect is still in the ledger doing the
  syncing, so a collapsed state re-expands as dtime updates land on it, starting
  from a tiny base. After the preprod replay below it was 23 KB, against 5.5 MB for
  the uncollapsed state. A stored reference is collapsed again each time a build
  or refresh completes. A wallet's own state never is, so it carries whatever it
  regrows.
- **Existing wallets are not helped.** The collapse applies to the reference, so a
  wallet seeded before this change keeps the dust state it was seeded with.
  Collapsing a wallet's own state is out of scope, and for a wallet holding DUST
  UTXOs it is unsafe on 8.1.x (Option D). That wallet keeps its bloated state and
  its per-launch deserialize. ledger-v9 is the path there.
- **A one-time cost for stored references.** A reference stored by an earlier
  version is collapsed the first time it is handed out, which costs one
  deserialize of the bloated state on that machine (about a minute on preprod), on
  the start-up of the first wallet seeded from it. The marker makes later calls
  free.
- **Existing assignments consume storage.** Old versions remain until their last
  wallet is removed or the user resets the network's reference state. Newer
  bundles and background updates do not evict birthday-compatible recovery data.
- **Ownership checks depend on ledger-v8's representation.** Its public DUST
  output list hides pending spends and exposes no NIGHT ownership map. Donation
  therefore also requires both ownership maps to be empty in the pinned ledger
  debug representation. A changed representation disables donation safely.
- **Background optimization still uses CPU and memory.** Serialization briefly
  runs in the wallet worker; expensive ledger work runs in a separate worker.
  The UI and wallet do not await it, but device resource contention is possible.

### Reset behavior

“Resync from scratch” preserves the behavior before this PR: clear the selected
wallet's caches and the network's references, assignments and working files, then
call `installBundledReference` on the next sync. A valid birthday-compatible bundle
may seed that sync. Otherwise DUST alone may use a witnessed reference after the
history check in ADR 0003; parts without either proof start from genesis. Reset is not an explicit
instruction to bypass every bundled reference. Other wallets keep their own caches.

### Neutral / follow-up

- End-to-end seeded-wallet timings have not been re-measured with a collapsed
  reference. The totals in `docs/BENCHMARKING.md` (29.3s and so on) predate it.
- The bundles re-cut in this change are the first collapsed ones. Their heights
  are recorded in their manifests.
- When ledger-v9 is adopted, delete the error-message workaround and re-evaluate
  whether the collapse still earns its place.
- qanet ships no bundle until one can be re-cut and verified (ADR 0004,
  2026-09-15 addendum).

## Evidence that a collapsed reference syncs forward identically

The checks inside `collapseDustReference` show the collapsed state is the same
state at the moment of collapse. On their own they do not show it stays the same
under the events that follow, in particular dtime updates that land on leaves the
collapse removed. That case was tested directly, by applying the same events to
the original and the collapsed state and comparing them:

| run | events replayed | dtime updates | inside the collapsed range | result |
|---|---|---|---|---|
| preprod, from the reference | 71,507 | 15,540 | 940 | roots, balance and UTXOs identical after every batch |
| preview, from the reference | 52,325 | 6,106 | 93 | identical throughout |
| unit test, recorded preview slice | 771 | 18 | 5 | identical |

Two more observations from the same work:

- **Regrowth:** after the preprod replay the collapsed state was 23 KB; the
  uncollapsed one was 5.5 MB.
- **Refresh:** `moth preseed refresh` on a collapsed preview reference advanced
  359,741 blocks in 193s.

The preprod and preview replays were one-off runs and are not part of the test
suite. The recorded preview slice is what keeps running.

Tests:

- `reference-versions.test.ts` and `wallet-host-references.test.ts` cover upgrade
  migration, wallet assignments, birthday eligibility, removal, reset races and
  background publication without waiting for optimization.
- `reference-candidate.test.ts` rejects owned and pending records, including the
  DUST records hidden by its public output list, and checks identity replacement,
  unchanged roots/cursors and immutable capture.
- `scripts/test-reference-worker.mjs` loads the production worker in headless
  Chrome with real WASM and a local indexer fixture. It checks startup, witness
  capture, identity replacement and main-thread responsiveness. Run after
  `yarn build`; set `CHROME_BIN` when Chrome is not at the default macOS path.
  CI runs this with the hosted runner's `google-chrome`.
- `packages/core/tests/unit/sync/dust-reference-collapse.test.ts` — the transform,
  its refusals, the offline replay, and the pinned `treeFrontier` workaround.
  Fixtures, and how they were recorded: `packages/core/tests/fixtures/preseed/`.
- `packages/core/tests/unit/sync/preseed-collapse.test.ts` — the one-time collapse
  of a stored reference, and its marker.
- `packages/core/tests/unit/sync/preseed-portable.test.ts` — collapse on import and
  export, and both witness formats.
- `packages/core/tests/unit/scripts/collapse-preseed.test.ts` — the bundle tool's
  checks and refusals.
- `packages/extension/tests/bundled-preseed.test.ts` — replacing an older stored
  reference.
- `packages/cli/tests/e2e/preseed-network.test.ts` — live network: import, refresh,
  seed a new wallet, and restore its dust state in under 10 s on relaunch (see
  `docs/TESTING.md`).

## Validation

- **Success criteria:** `collapse-preseed.mjs --check` passes on the committed
  bundles in CI and CD. The advisory `e2e-preprod` job shows a seeded CLI wallet
  syncing to tip with a dust state under 1 MB, and restoring it in under 10 s.
- **Failure signals:** the pinned `treeFrontier` test failing after a ledger bump.
  "could not collapse the reference's dust trees" in the progress output for a
  reference that owns no DUST. The E2E restore or size bound tripping on a run
  where the indexer was healthy. Any reported difference in balance or spend
  between a reference-seeded wallet and a genesis-synced one.
- **Review date:** when the ledger-v9 upgrade is taken up.

## References

- Related ADRs: [ADR 0003](0003-preseed-reference.md),
  [ADR 0004](0004-preseed-distribution.md), [ADR 0005](0005-preseed-for-cli-tui.md)
- Code: `packages/core/src/sync/dust-reference-collapse.ts`,
  `packages/core/src/sync/preseed.ts` (`collapseStoredReference`),
  `packages/core/src/sync/preseed-portable.ts`,
  `packages/extension/lib/offscreen/bundled-preseed.ts`,
  `scripts/collapse-preseed.mjs`, `scripts/lib/collapse-preseed.mjs`,
  `scripts/export-preseed.mjs`
- Workflows: `.github/workflows/ci.yml`, `.github/workflows/cd.yml`,
  `.github/workflows/prepare-preseed.yml`
- Field guide: `docs/patterns/preseed-sync-acceleration.md`
