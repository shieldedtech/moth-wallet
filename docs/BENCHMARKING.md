# Benchmarking the wallet

How to measure where wall-clock time goes — in the browser extension and in Node —
and what the numbers should look like.

Three instruments, for three different jobs:

| | use it for | where |
|---|---|---|
| **Phase timings** | unlock, account creation, transactions, reference builds | extension: `chrome-extension://<id>/debug.html`; CLI/TUI/daemon: `~/.moth/timings.json` |
| **`scripts/sync-benchmark.mjs`** | sync throughput, A/B of indexer and batch settings, a clean baseline | Node, against any network |
| **`scripts/dust-proving-check.mjs`** | whether a reference-seeded wallet can actually *spend*, not just sync | Node, needs a funded account |
| **`scripts/export-preseed.mjs`** | package a built reference into the extension, and report its size and staleness | Node |

The browser is the environment users have; Node is the one that gives repeatable
numbers. Measure in both — they are not interchangeable, and quantifying the gap
is itself useful.

The recorder behind phase timings lives in core
(`packages/core/src/diagnostics/timings.ts`) and is storage-agnostic: the
extension backs it with `storage.local`, Node with a file. The delta arithmetic,
the 500-entry cap and the never-throw policy are therefore identical on every
surface, and a timeline from the CLI is directly comparable with one from the
panel.

---

## 1. Browser: the phase timings page

### Setup

```bash
cd packages/extension
yarn compile && yarn build
```

> The repo pins `yarn@4.14.1` via `packageManager`; corepack rejects `npm` and
> `pnpm` here.

Load `packages/extension/.output/chrome-mv3` at `chrome://extensions`
(Developer mode → Load unpacked), then note the extension id and open:

```
chrome-extension://<id>/debug.html
```

Reachable **with no wallet and no unlock** — deliberately, since account creation
and the pre-seed reference build are the phases most worth measuring before a
first wallet exists, and the panel shows only the get-started screen then.

### Recording

1. **Start recording** on the page
2. Exercise the phase you care about (see recipes below)
3. Return to the page — it refreshes every 2s
4. **Copy JSON** or **Download** to keep or share the result

Each row is `time · Δ · source · phase`. **Δ is the cost of the phase that just
ended** — the gap between two labels is the thing being measured. The three
slowest rows are highlighted.

Sources: `sync` (core progress messages), `tx` (build/prove/submit),
`marker` (explicit boundaries, e.g. `unlock: start`, `first balances emission`).

Recording is off by default, is a no-op when off, and keeps the newest 500
entries. It captures **labels, durations and sizes only** — no addresses,
amounts, token ids or wallet names — so a timings file is safe to paste into an
issue.

---

## 2. Recipes

### Unlock (why the wallet screen takes a while)

Start recording → lock the wallet → unlock it → read the Δ column.

```
unlock: start (keystore decrypt + offscreen + WASM ahead)
unlock: keys ready (offscreen up, keystore decrypted)
Starting shielded wallet… / Restoring shielded state from cache…
Starting dust wallet… / Restoring dust state from cache…    ← usually the big one
Initializing wallet facade…
first balances emission (panel can render)                  ← what the user waits for
```

The interesting split is between the keystore KDF, offscreen creation plus WASM
instantiation, and the per-sub-wallet restores. In Node a 5.13 MB dust state
deserialized in **48.8s**; a 2.33 MB state should land near half that. If the
dust restore dominates, no amount of UI work will help — that is a state-size and
SDK cost.

Note lock deliberately clears the cached balances snapshot, so unlock cannot use
the fast path that ordinary cold opens do.

### A cold open that is *not* an unlock

Close the panel, wait ~15s (the idle teardown is 10s), reopen it. This path
*should* render from the cached snapshot. If you see a long gap before
`first balances emission`, the snapshot fast path is not working.

### New-account sync

The headline number. **Order matters:**

1. If testing the pre-seed path, first confirm Settings → Network shows **Ready**
2. Then create the account
3. Watch time to `dust synced`

An account created **before** the reference is ready can never benefit — the
birthday guard refuses a reference newer than the account, permanently, for that
account. That is the guard protecting history, not a failure. Accounts made while
waiting are throwaway.

This is also why a long-lived funded wallet is the wrong instrument for measuring
first-sync speed. Its birthday sits below every reference you hold, so it walks
from genesis no matter what is installed, and no amount of installing changes it —
a birthday authorises a reference rather than acting as a start height
([ADR 0006](adr/0006-birthday-authorises-a-reference.md)).
Benchmark with an account created **after** the reference it is meant to seed
from, and read `earliestSeedableBirthday` from `moth preseed status` to know what
the references you hold can actually serve.

Reference for preprod, no reference available: **78.6 min**, of which 99.2% is
dust. With a **fresh** reference: **29.3s** (11 Aug, reference 26 blocks stale).
An older reference is slower in proportion — see the staleness figures below. The
**49.2s** that circulated before 10 Aug came from a benchmark that could not seed
at all; treat it as unverified.

Since 2026-08-10 preprod ships a reference in the extension package, so a fresh
install seeds without any warming step. Verify it landed by looking for
`Pre-seed complete` in the timings, or `empty-ref/preprod/height.txt` in
IndexedDB.

### Pre-seed reference build

Settings → Network → "Speed up new accounts" → on. Expect **~71 min on preprod**,
per network, resuming across sessions. The Settings row shows `Preparing N%` from
the reference's dust progress, then `Ready`.

Confirm completion independently in IndexedDB (`moth` / `kv`):
`empty-ref/<network>/height.txt` present, and `sync/<network>/__empty_ref__/dust.dat`
in the megabytes. No height file means it has not finished and the reference stays
unused.

### DUST rebuild

DUST screen → "Rebuild records" (only offered when the local view looks stale).
Evicts the dust cache and nothing else, then re-seeds from the reference where one
is available — measured at **1.0s** on preview against a funded, dust-registered
wallet. Without a usable reference it is a full dust rescan, the same order as a
new wallet.

Until 2026-08-10 this always cost the full walk even with a reference present:
the pre-seed gate tested the *shielded* cache, which a dust rebuild does not
touch. If you see `syncing from genesis` here rather than
`Pre-seed complete — dust at chain tip`, check the birthday and reference height
before blaming the rebuild.

### Transactions

Send anything and read the `tx` rows: `building → proving → submitting`. Proving
dominates and depends on your prover setting (server vs WASM).

**A `submitting` row in the tens of seconds usually means the node, not the
wallet.** The relay reconnect backs off 2.5s → 5s → 10s → 20s → 40s → 60s, so a
submit against an unreachable node inherits whatever window is open when it
starts. Check the relay banner on Home first — with Settings → Developer mode on
it shows the endpoint, the HTTP status and the attempt count. Measure submission
only against a node that is actually answering, or the number is a measure of the
outage.

---

## 3. CLI, TUI and daemon

The sync engine is core, and these three use exactly the same one the extension
does — so **the numbers from `sync-benchmark.mjs` apply to all of them**. What it
does not capture is each surface's own overhead: TUI render cost, CLI per-command
process startup and unlock, daemon IPC round-trips.

For those, use the same recorder with the filesystem store:

```ts
import {createTimingRecorder} from '@shieldedtech/moth-wallet/diagnostics/timings';
import {FilesystemTimingStore} from '@shieldedtech/moth-wallet/diagnostics/fs-timing-store';

const timings = createTimingRecorder(new FilesystemTimingStore());
await timings.setEnabled(true);

// Pass it the progress stream every surface already has:
await startWalletSync(keys, network, (message) => void timings.record('sync', message), name);
```

Entries land in `~/.moth/timings.json` (`{enabled, entries}`), survive across
commands, and carry the same `at / deltaMs / label / source` shape the browser
page renders — so a CLI run and a panel run can be diffed directly.

`clear()` drops the entries but keeps the enabled flag, which is how you isolate
one phase mid-session without losing whatever comes next.

---

## 4. Node: `scripts/sync-benchmark.mjs`

Needs a built workspace (`yarn turbo run build`).

```bash
# Baseline: fresh wallet, birthday at chain tip
node scripts/sync-benchmark.mjs

# Full genesis scan (no birthday)
node scripts/sync-benchmark.mjs --from-genesis

# Warm the pre-seed reference first, then measure against it
node scripts/sync-benchmark.mjs --warm-reference --timeout 9000

# A/B the endpoint and the batch shape
node scripts/sync-benchmark.mjs --indexer http://localhost:8088/api/v4/graphql
node scripts/sync-benchmark.mjs --batch-size 2000 --batch-timeout 100 --batch-spacing 0

# Machine-readable
node scripts/sync-benchmark.mjs --json
```

Each run uses a **fresh random mnemonic**, so it measures chain traversal rather
than transaction volume. Milestones come from the same `SyncProgress` the UIs
consume, so "dust synced" means exactly what the DUST bar means.

Wallet state is held in memory and never written to `~/.moth`. The **reference**
is the exception, and is read from disk: the measured wallet's store is an
overlay that reads the `empty-ref/*` and `__empty_ref__` keys through to the
on-disk store and keeps everything else in memory. Without that, the wallet
searches an empty store, never finds the reference, and every run silently
measures the unseeded path. `--warm-reference` also *writes* the reference to
disk, so later runs and the real CLI can reuse it.

The birthday is read **after** any warm, not before. It has to be: warming takes
minutes to an hour, the chain moves under it, and a birthday captured first is
older than the reference the run just built — so `reference.height <= birthday`
fails and the run measures the unseeded path while announcing itself as warmed.

To confirm a run actually seeded, look for this line:

```
[sync] +0.0s Pre-seed complete — shielded + unshielded + dust at chain tip
```

If you instead see `syncing from genesis` or `no reference at chain tip`, the
number you are about to read is the unseeded path.

**Measured on preview** (chain tip ~361,000; 64,771 dust events):

| | wall clock |
|---|---|
| no reference | 94.5s |
| seeded from reference | **2.2s** (ref ~200 blocks stale) · **8.7s** (18,228 stale) |
| building the reference itself | 96.0s |

> **`percentage` in `--json` changed meaning.** It used to track shielded indices
> alone; it is now the minimum across all three sub-wallets and is clamped to 99%
> until the facade itself reports synced. JSON captured before that change is not
> comparable. The `milestones` timings are unaffected.

> **`percentage` in `--json` changed meaning.** It used to track shielded indices
> alone; it is now the minimum across all three sub-wallets and is clamped to 99%
> until the facade itself reports synced. JSON captured before that change is not
> comparable. The `milestones` timings are unaffected.

---

## 5. Node: `scripts/dust-proving-check.mjs`

Answers a different question from the other two: not *how fast* a reference-seeded
wallet syncs, but **whether it works at all**.

The pre-seed copies an empty wallet's DUST state — the global generation tree plus
a cursor — into a new wallet with the keys swapped. That is proven to sync. It has
never been shown to *spend*: every benchmark wallet held 0 NIGHT and 0 DUST, so no
dust proof was ever exercised against a copied tree. If a copied tree cannot
satisfy proving, the reference is a display optimisation rather than a fix.

```bash
node scripts/dust-proving-check.mjs                        # preprod
node scripts/dust-proving-check.mjs --network preview
node scripts/dust-proving-check.mjs --send-to <mn_addr…>   # step 4 target
```

Four steps, resumable — re-run the same command and it does the next one:

1. create a reference-seeded account → prints the address to fund
2. wait for NIGHT to arrive
3. register that NIGHT for DUST generation
4. once DUST > 0, send a fee-paying transaction — the actual test

**Not fully automatable, for a structural reason.** The account must be funded
with NIGHT *after* the reference height: seeding an already-funded wallet is
refused by design, since its NIGHT predates the reference and seeding would skip
its own history. So a human has to send NIGHT to the address from step 1, and
enough time has to pass for that NIGHT to have generated DUST worth spending.

That wait is not a fixed grace period, which an earlier version of this file said
it was. Generation is linear from the UTxO's creation and scales with the amount
held, so a lightly funded check wallet waits hours where a well funded one waits
seconds — fund it generously if you want the check to finish promptly. See
[the registration bootstrap](./patterns/midnight-wallet-characteristics.md#the-registration-bootstrap-and-the-trap-in-it).

State (a throwaway mnemonic) lives in `~/.moth/dust-proving-check-<network>.json`
so progress survives between runs. **Never fund it beyond test amounts.**

Steps 3 and 4 broadcast transactions, so they need a reachable node — on a network
whose RPC is refusing connections the script cannot get past step 2.

---

## 6. Interpreting results

**Reference figures, preprod, one machine.** Absolute numbers drift with indexer
load; ratios are the durable part.

| phase | measured |
|---|---|
| new wallet, no reference | 78.6 min (dust 4715.8s; unshielded 3.4s; shielded 38.6s) |
| new wallet, fresh reference (26 blocks stale) | **29.3s** |
| new wallet, reference 76,965 blocks stale | 117.5s |
| reference build (one-off, per network) | 53.6–71.3 min |

**Preview, for scale** — same shape, a 5.5× shorter chain (64,771 dust events):
no reference 103.3s, seeded 8.7s (reference 18,228 blocks stale), reference build
96.0s. Useful for iterating on the pre-seed path without paying preprod's hour.

**A stale reference costs time, not correctness.** Measured on preprod against the
same reference at two ages:

| reference staleness | seeded total |
|---|---|
| 26 blocks | **29.3s** |
| 76,965 blocks | 117.5s |

That is ~1.1ms per block of drift, or roughly **half a second per hour of
reference age**. The residual 29.3s is the floor — deserializing a 10.2 MB dust
state with nothing left to catch up on.

This is what makes a bundled reference viable: it is stale by definition the
moment it ships, and a reference cut at release is still under two minutes of
catch-up a month later.

**Batch tuning is not the lever.** On preview, quadrupling batch size and removing
spacing moved 8.7s to 8.5s — inside noise — while pre-seeding moved 103.3s to
8.7s. All runs applied identical event counts; only the starting cursor differs.

**A DUST rebuild re-seeds rather than walking from genesis.** Evicting only the
dust cache (what "Rebuild records" does) used to leave shielded cached, which shut
the pre-seed gate and cost the full walk. Measured after the per-part fix on a
funded, dust-registered preview wallet: dust resumed at the reference cursor and
reached synced in **1.0s**, with NIGHT, the registration and the DUST balance all
preserved.
| warm reference lookup | 0.02s |
| `DustLocalState.deserialize`, 5.13 MB | 48.8s |
| dust apply rate | ~293 events/sec over 1,382,732 events |
| chain | ~6.0 s/block; dust events ~46/hour recent, ~420/hour lifetime average |

**Compare like with like.** Prefer **dust events/sec** over total wall clock: the
total folds in reference-build and pre-seed noise, while the rate is comparable
across runs and between Node and the browser.

**Expect the browser to be slower** than Node — different WASM path, plus
IndexedDB writes. Treat the Node deserialize figure as a floor, not a target.

---

## 7. Pitfalls

- **Check the run actually seeded before quoting it.** Until Aug 10 the script
  could not measure the seeded path at all: the measured wallet got a bare
  in-memory store (so the reference was never found) and the birthday was read
  before warming (so the guard refused it). Both modes silently reported the
  unseeded number. Any figure captured with an older copy of this script that
  claims a warm reference should be re-measured rather than trusted.
- **Do not measure immediately after building a reference in the same process.**
  One run that did so took 1052s where two independent fresh-process measurements
  say ~49s. The cause is not established (heap/GC pressure, or a reference facade
  not fully torn down). Restart the process, or build the reference in one run and
  measure in another. This is also the main argument against building references
  on user devices.
- **Sample long enough.** An early four-minute window suggested 419 events/sec;
  the full run averaged 293. Rates decay — project from a full run, not a prefix.
- **One sample is one sample.** These run against a shared public indexer. Repeat
  2–3 times before believing a delta, especially when A/B-ing batch settings.
- **Stale build output after a branch switch.** `tsc` does not delete outputs
  whose sources vanished, and turbo will cache the orphans. Reset with:
  ```bash
  find packages -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete
  rm -rf packages/*/dist && yarn turbo run build --force
  ```
- **The extension and CLI have separate stores.** IndexedDB (`moth`/`kv`) versus
  `~/.moth`. A reference warmed in Node does **not** help the extension, and vice
  versa.

---

## Related

- `docs/adr/0003-preseed-reference.md` — the pre-seed mechanism, its measurements,
  and the `height <= birthday` safety rule
- `packages/core/src/diagnostics/timings.ts` — the recorder, the `TimingStore`
  interface, and what it deliberately does not capture
- `packages/core/src/diagnostics/fs-timing-store.ts` — the Node/CLI store
- `packages/extension/lib/background/timings.ts` — the extension store
- `scripts/sync-benchmark.mjs` — the header documents every flag
- `scripts/dust-proving-check.mjs` — the header documents every step
- `docs/TESTING.md` — functional smokes for CLI and daemon modes (not performance)
