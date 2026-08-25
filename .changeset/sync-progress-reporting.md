---
'@shieldedtech/moth-wallet': patch
---

Report sync progress that is neither invented nor erased.

Two defects in how progress reached the surfaces, close enough together in
`extractBalancesPartial` that fixing them apart would mean resolving the same
twenty lines twice.

**A partial emission erased a sub-wallet.** Each sub-wallet's coins and its
progress were read inside a single `try`, and the coin loops reached into the
state without the optional chaining used one line above on the balances:

```ts
const sb = state.shielded?.balances;              // guarded
for (const c of state.shielded.availableCoins) {  // not guarded — throws here
…
subProgress.shielded = {applied, total};          // never reached
```

An emission carrying no slice for a part threw in the loop and skipped the
progress assignment, leaving `{applied: 0, total: 0}` — which `fraction()` treats
as **complete**, correctly for a sub-wallet with genuinely nothing to apply and
catastrophically for one whose slice was simply absent. The TUI alternated about
once a second between real figures and `synced · 0 / 0` with no balance. Coins
and progress now read separately, all six coin loops are guarded, and each part
carries its previous value forward when an emission says nothing about it;
progress does not go backwards inside a session. A genuinely 0/0 part still
counts as complete rather than stalling the overall figure.

**The ETA assumed every sync starts at zero.** `etaSeconds` was
`elapsedMs / percentage - elapsedMs`, which treats cumulative progress as this
session's work. Dust resumes from cache constantly, so a run that restored at
~65% and then ran 152s was read as "67% in 152s" — fifteen times the real rate.
Measured on preprod it promised 1m15s at 67% and 2m23s at 81% against a true
~10m, and the estimate *climbed* as elapsed time corrected the fiction. The rate
now comes from a per-session baseline: the same inputs give 41m and 12m19s,
falling as the run proceeds. Below 0.2 points of movement it reports nothing,
since an admitted unknown beats a number derived from noise.

Both bugs predate the CLI/TUI parity work, which only made the first visible by
putting per-sub-wallet counters on screen. The daemon and extension read the same
balances.
