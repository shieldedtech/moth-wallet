---
'@shieldedtech/moth-wallet': patch
---

Settle the pre-seed command group at `moth preseed`, not `moth dust preseed`.

Two branches had grown separate trees for the same concept. DUST is why the
pre-seed matters — it is the 4.9 MB blob, the ~1.4M events, the tens of minutes,
where shielded and unshielded take seconds — which made `dust preseed` tempting.
But that describes the motivation, not the thing: the pre-seed writes all three
sub-wallet caches, and a reference is per-network machine state in `~/.moth`
shared by every wallet there, whereas `moth dust` groups per-wallet token
operations. A command tree should say what a thing is, and someone whose first
sync is crawling searches for "preseed" rather than reasoning their way to DUST.

Decided while neither surface had shipped, so the accurate name cost nothing.
ADR 0005 records the reasoning and supersedes its own earlier proposal; the
README, ADR 0003 and the command spec now document `status`, `install` and
`build` consistently, with `install` presented as the first thing to reach for
since the repo already commits the state `build` would spend minutes producing.
