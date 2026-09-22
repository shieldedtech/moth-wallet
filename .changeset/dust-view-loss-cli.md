---
'@shieldedtech/moth-cli': minor
---

`moth dust check` and `moth dust rebuild`, and dust coins in `moth wallet status`.

`dust check` compares the wallet's DUST view with the chain: every live
generation entry the indexer holds for the dust address must have a coin in
the local view, and the local cursor must be at the indexer's tip. With a
daemon or TUI hosting the wallet it checks the live view; otherwise it reads
the cached `dust.dat` and compares that (`--offline` forces this). Exit code 2
when the view is incomplete, so a bot can gate on it.

`dust rebuild` evicts only the dust sync cache and resyncs it, keeping shielded,
unshielded and history — in place on a running daemon, or on the next sync
otherwise. The resync starts from the pre-seed reference when the indexer
proves the wallet has no earlier DUST history, and from genesis when it does.

`wallet status` now lists each dust coin (generated / cap, backing NIGHT,
spend sequence, creation time) and the view verdict, and `--output json`
carries the daemon's full `coins`, `dustGeneration` and `dustView`. `0.3 DUST`
alone could not tell "one small coin" from "one small coin plus a large one
mid-spend" from "one small coin and a large one the view has lost".

The daemon started by `moth daemon serve` exposes the matching `checkDustView`,
`rebuildDust` and `restartSync` verbs.
