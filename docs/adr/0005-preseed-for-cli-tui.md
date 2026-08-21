# ADR 0005 — Surface parity: pre-seeding, timings and DUST UX across CLI, TUI and daemon

- **Status:** Accepted
- **Date:** 2026-08-12
- **Related:** ADR 0003 (the mechanism and the `height <= birthday` guard), ADR 0004 (CI, storage and retrieval of published references), `packages/core/src/sync/preseed.ts`, `packages/extension/lib/offscreen/bundled-preseed.ts`

> **Revised 2026-08-12.** Originally scoped to pre-seeding. A parity audit found
> the same shape in two more places — the phase-timings recorder and the DUST
> registration estimate — so the scope is widened rather than duplicated into a
> second ADR. The decision is unchanged: give the CLI and TUI the state and the
> commands the extension already has.

## Measured parity, before this work

| capability | core | extension | CLI | TUI |
|---|---|---|---|---|
| Pre-seed consumption | yes | yes | **no birthday** | **no birthday** |
| Bundled reference | — | yes | no | no |
| Build / refresh | exported | Settings toggle | **no command** | **no command** |
| Phase timings | storage-agnostic | 4 call sites | **0** | **0** |
| DUST "not yet" estimate | yes | yes | `--wait` | **0** |

Two of these are worse than they look. The timings recorder was deliberately
made storage-agnostic so every surface could use it, and `docs/BENCHMARKING.md`
already documents a `~/.moth/timings.json` — which nothing wrote. And the DUST
registration estimate reached the CLI but not the TUI, so the failure that
prompted it ("That didn't go through", pointing at the proof server) was still
live on one surface.

## Context

Pre-seeding lives in core. `startWalletSync` reads a reference and seeds a new
wallet's sub-wallet caches from it, which is a path every run mode goes through —
extension, `moth` CLI, TUI and `moth daemon serve` all call the same function.

It looks shared. It is not. **No CLI or TUI wallet has ever been pre-seeded, and
none can be**, because three independent conditions each fail on their own:

1. **No birthday.** `startWalletSync` seeds only when `isNewWallet || birthday`
   holds (`sync/wallet-sync.ts`), and the safety guard then requires
   `reference.height <= birthday`. The CLI's `wallet generate` calls
   `manager.generate(name, passphrase, network)` with no birthday
   (`cli/src/commands/wallet/generate.ts`); the TUI does the same
   (`tui/src/app.tsx`, `tui/src/hooks/useWallet.ts`). Only the extension passes
   one, because only the extension asks the chain for its tip at creation time.
   No CLI or TUI call site passes `isNewWallet` either — every one of them stops
   at the `walletName` argument. The TUI even keeps a `newWallets` ref commented
   *"eligible for pre-seed optimization"* that is never threaded through to the
   sync call.

2. **No reference to seed from.** `installBundledReference` is in the extension's
   offscreen document. Nothing puts a reference into a CLI or daemon sync store.

3. **No way to build one.** `warmEmptyRefCache` and `refreshEmptyRefCache` are
   exported from core, but no CLI command calls either. The measurements in
   `docs/BENCHMARKING.md` were taken with loose `scripts/*.mjs`, not through any
   shipped command.

So the run modes a developer reaches for first — CLI in CI, TUI at a desk — still
pay the full walk: **78.6 min on preprod**, where the extension now takes 29.3s.
The gap is invisible from the code, because the capability is present in the
shared layer and only the wiring is missing.

Worth stating plainly: this was not a decision anyone made. Pre-seeding was built
for the extension's fresh-install problem, and the CLI was never wired up. The
`newWallets` comment is evidence someone intended to and stopped.

## Decision

Three changes, in dependency order. Each is useful alone.

### 1. Give CLI and TUI wallets a birthday

`manager.generate` already takes `birthday?: number`. The CLI and TUI must
resolve the chain tip at creation and pass it, as `walletSetActive` does in the
extension.

The safety rule from ADR 0003 is unchanged and non-negotiable: **only wallets
generated locally get a birthday. A wallet restored from a mnemonic never does**,
because it may hold funds at any height, and seeding it past its own history
loses them silently. `manager.import` must keep passing nothing.

This one change is worth making even before the rest: without a birthday, a
reference cannot be used no matter how it arrives.

### 2. A `preseed` command group

```
moth preseed status         # height, staleness, whether one exists
moth preseed import <dir>   # load a published reference (seconds)
moth preseed refresh        # catch an existing one up (9.1s measured)
moth preseed build          # first build for this network (tens of minutes)
moth preseed export <dir>   # write one out, in the format CI publishes
```

**Top-level, not under `dust`.** An earlier draft of this ADR proposed `moth dust
preseed …`, reasoning that DUST is why the pre-seed matters — it is the 4.9 MB
blob, the ~1.4M events, the tens of minutes, where shielded and unshielded take
seconds. True about the motivation, wrong about the thing: the pre-seed writes
all three sub-wallet caches, and a reference is per-network machine state in
`~/.moth` shared by every wallet on the machine, whereas `moth dust` groups
per-wallet token operations (`register`, `deregister`, `status`). A command tree
should say what a thing is; the "why" belongs in its description. Discoverability
agrees — someone whose first sync is crawling searches for "preseed", and only
learns the DUST connection from the output.

Settled while neither surface had shipped, so the accurate name cost nothing.

Each action is a real oclif subcommand rather than one command taking an action
argument, so `--timeout` belongs to `build` and `--force` to `import` instead of
every flag hanging off the group with "(build only)" in its description.

`build` and `refresh` are thin wrappers over the core functions that already
exist. `import`/`export` make the reference a portable artifact, which is what
lets one machine's hour become every other machine's seconds — including CI,
where a persistent per-network cache plus `refresh` costs seconds per run.

This also promotes `scripts/export-preseed.mjs` from a loose script into a
supported command, which is where the benchmark tooling should have been.

### 3. Wire the timings recorder outside the extension

`createFileTimingStore` backs the existing recorder with a JSON file, and the
CLI's `BaseCommand` exposes it as `this.timings`, writing `~/.moth/timings.json`.
Off unless `moth diagnostics timings on` has been run, so the cost is one file
read per command otherwise — the same trade the extension makes.

`moth diagnostics timings` is the CLI's `debug.html`: it prints the timeline as
deltas rather than absolute stamps, because the question is where the wall clock
went, not what time it was.

### 4. Surface the DUST registration estimate in the TUI

`DustRegistrationNotYetError` already carries the wait. The TUI now catches it
distinctly and reports "not possible yet" rather than logging the raw SDK message
as a failure.

### 5. Retrieval, deferred to ADR 0004

A CLI cannot bundle a reference inside a signed package the way the extension
does — that property is what makes the extension's bundling trustworthy without a
new trust surface (`bundled-preseed.ts` argues this at length). A CLI fetching a
reference over the network is exactly the case ADR 0004 is about, and it should
be decided there rather than twice.

Until then, `preseed import` plus a reference the operator produced or trusts is
the honest answer: no new trust surface, no network dependency, and it works
today.

## Consequences

**Good.** CI runs that create a wallet stop paying an hour. The TUI becomes usable
on a fresh machine. `refresh` and `export` give the release process a supported
path to produce the artifact the extension bundles, instead of a script someone
remembers.

**Cost.** Birthday resolution adds a tip query to wallet creation, so
`wallet generate` now needs a reachable node. It must degrade to "no birthday,
slow sync" rather than failing to create a wallet — a wallet the user can hold is
worth more than a fast first sync.

**Not addressed.** A first `build` still costs tens of minutes on the machine that
does it. That is inherent until the wallet SDK consumes the collapsed-update
endpoints (`docs/patterns/midnight-wallet-characteristics.md`), at which point
this ADR and ADR 0003 both retire rather than migrating.

**Deliberately excluded.** Auto-building on CLI startup. The extension's own
comment on `ensureEmptyRefCache` explains why: an hour-long chain walk on the
startup path is worse than a slow sync in the background, and a CLI command that
silently blocks for an hour is worse still.

## Alternatives considered

**Leave it.** The CLI is a developer tool and developers can wait. Rejected on the
evidence: CI is where waiting is most expensive and least visible, and the
capability is already paid for.

**Have the CLI build a reference automatically on first use.** Rejected — see
above. The cost has to be something the operator chooses.

**Skip birthdays and seed any wallet lacking a cache.** Rejected outright. This is
the fund-loss bug ADR 0003 exists to prevent: a wallet with no cache may still
have history, and seeding it past that history hides its coins with no error.
