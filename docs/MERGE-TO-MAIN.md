# Landing v.next on main

Five branches were integrated and tested together on `feat/v.next`. They go to
`main` as separate PRs, in a specific order, and two of the conflict resolutions
were judgement calls you should look at rather than re-derive.

| | |
|---|---|
| Integration tip | `8a06557` |
| Verified at | 6/6 builds · 886 tests · biome clean |

---

## Two rules before you start

**Do not merge `feat/v.next` itself.** It is a disposable integration branch.
Merging it would collapse five reviewable changes into one merge commit and bury
the resolutions described below. Merge the PRs individually; delete `v.next`
when they are all in.

**#70 must land with #50 and #51, not after them.** Neither PR has that bug
alone — the merge creates it. #50 refuses a pre-seed reference whose cursors no
longer name the same events; #51 adds references archived per height. They
disagreed on what identifies a reference, so an archived one carried no
witnesses and was handed out with no renumbering check at all. That is the path
an *older* wallet takes, so the check went missing exactly where a stale cursor
is most likely — and it fails silently: the sync resumes at the wrong event and
the balance is quietly wrong.

---

## Merge order

Order is load-bearing. The counts are measured, not estimated — each branch was
test-merged onto the tree the previous step produces.

### 1. Mainnet refusal at the flag — PR #52 · `fix/mainnet-refusal-at-the-flag`

**0 conflicts.** Closes #25. Touches 7 files, conflicts with nothing in the set.
Free — take it first.

### 2. Indexer cursor witness — PR #50 · `fix/indexer-cursor-witness`

**0 conflicts.** Closes #40, and carries the re-cut pre-seed bundles for
preprod, preview and qanet. Everything downstream wants those bundles present,
so it goes before the birthday work.

### 3. Wallet birthday — PR #51 · `feat/wallet-birthday`

**3 conflicts.** Closes #46, #47, #48, #49, #54, #55, #56, #57.

First fold in the TUI birthday fix, which has no PR of its own and sits one
commit ahead of #51's head. Without it, an import silently drops the birthday
claim and syncs from genesis (#68), and the wizard writes one chain's height as
another chain's birthday (#69).

```bash
git checkout feat/wallet-birthday
git merge 27e36eb   # fix(tui): carry the birthday claim to the end of onboarding
git push
```

Then merge #51. Conflicts are against #50 — see [Resolutions](#resolutions-to-re-apply).

### 4. CLI/TUI parity — PR #11 · `feat/cli-tui-parity`

**10 conflicts.** The big one, and the reason the order is what it is. Merging
#11 before #51 puts all of this into a single 12-file merge that mixes
birthday-vs-parity with birthday-vs-witness; this way each merge has one theme.

### 5. Archived-reference verification — issue #70 · commit `042ca9b`

**Needs a branch.** Only exists on `v.next`. Depends on both #50 and #51, so it
cannot merge before them — and should not merge long after.

> **Split this commit first.** `042ca9b` also contains `scripts/test-setup.sh`,
> an unrelated 90-line helper that `git add -A` swept in. Take it out before
> opening the PR, or reviewers will be reading a shell script inside a pre-seed
> fix.

### 6. Batch transfer amounts — issues #66, #67 · commit `a794c27`

**Needs a branch.** Stranded on `fix/cli-usability`, whose PR already merged.
Give it a fresh branch off `main`. Independent of everything above, so it can go
any time.

```bash
git branch fix/batch-amounts a794c27
git push -u origin fix/batch-amounts
```

### 7. Test harness and docs — commits `2dcc6e7`, `8a06557`

**Needs branches.** The end-to-end harness under `scripts/e2e/` and the
`docs/TESTING.md` pointer to it. Both additive, neither pushed. Last, or
whenever.

---

## Resolutions to re-apply

Each PR merges to `main` on its own, so these conflicts recur. Every one is a
union — both features survive. Nothing here is a "pick a side".

### #51 against #50 — three files

| File | Resolution |
|---|---|
| `core/src/index.ts` | Adjacent export blocks that do not overlap. Keep both; take the `preseed.js` line that includes `archivedReferenceHeights`. |
| `core/src/sync/preseed.ts` | `ensureEmptyRefCache` takes #51's birthday gate on the outside with #50's `referenceCursorsStillValid` inside it, so a reference is used only when it is at or below the birthday **and** its cursors still name the same events. The build path records witnesses *and* archives at height, with #51's `at block {height}` message — #50's "at chain tip" wording is what #51 corrected. |
| `extension/lib/offscreen/bundled-preseed.ts` | #51's restructured `installBundledReference` (it introduced `fetchStates` and archive-on-install), with #50's witness writes restored on the path that fills the live slot. |

### #11 against the rest — ten files

| File | Resolution |
|---|---|
| `core/src/index.ts` | **Read the `chainTip` note below first.** Union of three unrelated export groups, minus one duplicate. |
| `cli/src/base-command.ts` | Keep parity's `timings` getter **and** #51's `syncBirthday`. Take parity's plain `return this.walletManager.birthdayOn(…)`: core's docstring guarantees it never throws, so the `try/catch` was dead code. |
| `cli/src/commands/balance.ts` | Both the timings marker and the birthday comment. The `startWalletSync` call itself auto-merges with both. |
| `cli/src/commands/preseed/status.ts` | Full union: #51's `tip`, `archivedHeights` and `earliestSeedableBirthday` plus parity's `message`. |
| `cli/src/commands/preseed/build.ts` | Full union: #51's `--force` / `refreshEmptyRefCache` path and its "nothing advanced" reporting, plus parity's dust-event progress and `minutes`. |
| `cli/src/commands/wallet/generate.ts` | #51's object-form `chainTip` call, parity's tidier import and its ADR 0003 reference. |
| `core/src/wallet/manager.ts` | Same docstring, reflowed. Take parity's; behaviour is identical. |
| `tui/src/hooks/useWallet.ts` | Keep the caller-supplied `birthday` parameter. Parity's resolve-inside-the-hook variant is not wrong about networks, but merged `app.tsx` passes `chosenTip` from `tipFor()` — the #69 fix — and parity's 3-argument signature would silently ignore it. |
| `cli/tests/unit/preseed-call-sites.test.ts` | Parity's side is empty. Keep #51's generate-call-site guard; it passes on the merged tree, so no call site lost its birthday. |
| `docs/adr/0005-preseed-for-cli-tui.md` | Merge both command lists so `install` and `import` both survive, and keep parity's note about flags belonging to subcommands. |

### Both branches added a `chainTip`, with different contracts

- `core/src/network/block-time.ts` returns `HeightAtTime | null` (#51)
- `core/src/sync/chain-tip.ts` returns `number | undefined` (#11)

After the merge the barrel exported the same name twice, which does not compile.

Every real caller — `preseed/status.ts`, `wallet/import.ts`, `app.tsx`,
`wallet/generate.ts` — uses the object form, and nothing but the barrel line
referenced #11's module. **Keep block-time's, drop the duplicate export, delete
the orphaned file.** Resolving it the other way makes `generate` hand
`manager.generate` an object where it wants a number.

---

## Two judgement calls to review

These go beyond picking a side. If you disagree, this is the place to say so.

**1. `preseed build --timeout` is now wired.** Parity declared the flag,
documented it in an example and in ADR 0005, and never read it. It is now raced
against the build with a timer, which matches #51's existing "progress is saved,
re-run resumes" error text. The alternative was deleting the flag.

**2. `preseed status`'s message names the earliest seedable birthday.** Parity's
message named the live reference height. With archives present that no longer
answers "will my wallet seed?", so the message names `earliestSeedableBirthday`
instead. Live output from the merged tree:

```json
{
  "network": "preprod",
  "tip": 2233928,
  "liveReferenceHeight": 2203416,
  "ready": true,
  "archivedHeights": [2104384, 2064324],
  "earliestSeedableBirthday": 2064324,
  "message": "Reference at height 2203416. A wallet with a birthday at or above 2064324 starts from a reference; anything earlier syncs from genesis."
}
```

---

## Verify

Run this after each PR merges, not just at the end.

```bash
yarn install && yarn build && yarn test
npx biome check packages
```

| Check | Expected at `8a06557` |
|---|---|
| Turbo build | 6 successful, 6 total |
| Vitest | 886 passed, 34 skipped |
| Biome | exit 0 |

Numbers below that after a merge mean a resolution dropped a test file — most
likely `preseed-call-sites.test.ts` or `archived-witness.test.ts`, both of which
arrive through conflicted merges.

### End-to-end check against a live testnet

The harness drives a funded wallet through the whole surface — imports from a
seed phrase, creates a throwaway wallet, funds it, registers it for DUST, spends
back from it, optionally sweeps home — in-process and through the daemon.

```bash
cp scripts/e2e/e2e.config.example.json ~/moth-e2e.config.json
chmod 600 ~/moth-e2e.config.json
scripts/e2e/moth-e2e.sh --config ~/moth-e2e.config.json --mode both --return-funds
```

Set `funding.birthdayHeight` to an archived reference height (2064324 on
preprod) or the first phase walks from genesis for an hour. After #70 the
archived reference is verified before use, so expect
`Pre-seed: using reference at block 2064324` rather than a refusal. Full detail
in [`scripts/e2e/README.md`](../scripts/e2e/README.md).

---

## Housekeeping

- **#59, #60, #62, #63** are fixed and on `main` already, but still open —
  GitHub only auto-closed #58 from the `Fixes #58, #59, …` list in PR #65. Close
  them by hand.
- **#53** ("`moth config` is unusable") does not reproduce on this branch:
  `config get`, `config set` and the bare `config` all behave. Re-check and
  close rather than fix.
- **#30** (ledger v9) was deliberately left out of the integration branch. It
  conflicts with the birthday work in 11 files, so expect that separately.
- Delete `feat/v.next` and `fix/tui-birthday-dropped` once everything is in.

---

Written against `feat/v.next` at `8a06557`. Conflict counts and test numbers are
measured from that tree; re-measure if `main` has moved.
