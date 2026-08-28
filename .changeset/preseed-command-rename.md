---
'@shieldedtech/moth-wallet': patch
---

Move the pre-seed commands from `moth dust preseed` to `moth preseed`.

DUST is why the pre-seed matters — the 4.9 MB blob, the ~1.4M events, the tens of
minutes, where shielded and unshielded take seconds — which is what put it under
`dust`. But that describes the motivation, not the thing: the pre-seed writes all
three sub-wallet caches, and a reference is per-network machine state in `~/.moth`
shared by every wallet there, whereas `moth dust` groups per-wallet token
operations. A command tree should say what a thing is, and someone whose first
sync is crawling searches for "preseed" rather than reasoning their way to DUST.

Settled while the command had not shipped, so the rename costs no compatibility.

Each action is now a real subcommand — `preseed status|import|refresh|build|export`
— instead of one command taking an action argument. `--timeout` therefore belongs
to `build` and `--force` to `import`, rather than every flag hanging off the group
with "(build only)" in its description, and each gets its own `--help`. The group
carries an oclif topic description; without one the help listed the whole group
under whichever subcommand sorted first.
