---
'@shieldedtech/moth-wallet': patch
---

Re-cut the pre-seed bundles from genesis, and add one for qanet.

The preprod bundle recorded dust cursor `1431375`, written under the indexer's old
numbering. Under the numbering now served, that id names an event 22 positions
later than the state the snapshot holds, so every wallet seeded from it resumed
past 22 dust events — no error, just missing generation history (#40).

All three references were rebuilt from genesis rather than refreshed, because a
refresh resumes from the stored cursor and would have carried the old numbering
forward into a bundle that then looked freshly built:

| Network | Height | Build | Dust cursor |
| --- | --- | --- | --- |
| preprod | 2,203,416 | 55 min | 1,449,958 (was 1,431,375) |
| preview | 519,470 | 3 min | 141,062 |
| qanet | 2,314,786 | 14 min | 346,693 |

Each manifest now carries a witness per cursor, so a consumer can tell whether the
numbering it was written under still holds — these are the first bundles that can
be verified rather than trusted, and the first that the installer will accept.

qanet ships for the first time. It costs 140 KB, not the several megabytes preprod
does: its chain is longer but has far fewer dust events, and dust is what makes a
reference large. The control that offers on-device warming probes which networks
ship a reference rather than listing them, so no code changed to add it.
