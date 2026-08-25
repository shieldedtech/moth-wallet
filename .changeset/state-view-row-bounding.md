---
'@shieldedtech/moth-tui': patch
---

Bound the Wallet State view's coin lists to what the terminal can show.

Observed on mainnet, where a shielded wallet holds far more coins than a test
wallet does. The itemised list ran past its own section and painted over the ones
beneath it, so the Unshielded and Dust sections printed lines like

```
▸ Unshielded Wallet
    Ba29ed4a053c1ec576e7f7684832c062bebc5cf67c0a4a9242f4defebd4b112b94  522  (1 coin)
```

— that section's `Balance` label with a token row on top of it.

The cause is not formatting. Ink renders a frame in full and has no viewport, so a
frame taller than the terminal corrupts its redraw and lines overwrite one
another. `components/Select.tsx` already documents exactly this ("makes Ink
collapse the two lines onto one") and windows its list against `stdout.rows` to
avoid it; `StateView` had no equivalent and emitted a row per token plus a row per
coin, unbounded. `Label` pads with `padEnd` and never truncates, which is what
identifies the 2-character `Ba` as terminal overwrite rather than a truncation
bug — and why truncating the label would have fixed nothing.

Each block is now bounded as a whole, with the remainder reported:

```
    Balance
      29ed4a05…4b112b94  522  (1 coin)
      … and 4,312 more
```

Bounded as a whole because volume arrives from either direction — a wallet with
many tokens, or a token with many coins — and capping only the inner coin list
leaves the outer one unbounded. The rows are flattened into one list and one
budget covers them, so neither shape can overflow. The three sections split the
terminal's spare height; the `… and N more` line is counted against the budget it
belongs to.

Long token ids are now middle-elided to fit the terminal width. That is not only
cosmetic: at 80 columns a full 64-character id wrapped the header onto a second
line, which cost two rows where the budget assumed one.

`Dust` had the same unbounded shape and is fixed the same way, costing a
deregistered coin as two rows since it renders its `dtime` on a second line.

The row arithmetic lives in `utils/` as `flattenBalanceRows`, `windowRows`,
`truncateMiddle` and `balanceBudget`, unit-tested without rendering Ink.
