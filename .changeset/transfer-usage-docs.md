---
'@shieldedtech/moth-wallet': patch
---

Document `moth transfer` as it actually works.

The README showed `moth transfer <amount> NIGHT --to <addr>` on two rows. That form
does not parse — `transfer` declares one positional and rejects the second with
`Unexpected argument: NIGHT`. It was the documented invocation, so it was the first
thing a new user would type.

Corrected to `moth transfer [<amount>] [--to <addr>]`, and the rows now say what
was previously stated nowhere: the in-process command is NIGHT-only, with the
token hardcoded and no flag to change it. A row for `moth daemon transfer` covers
the path that *can* move other tokens, including the distinction between
`--amount` (raw smallest units, any token) and `--night` (a decimal converted at
10⁶ STARS, refused for anything but NIGHT).

Docs only. Whether the in-process command should grow token selection is the open
half of #62.
