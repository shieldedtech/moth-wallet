---
'@shieldedtech/moth-wallet': patch
---

Fix four birthday and pre-seed bugs found in review (#46, #47, #48, #49).

**`preseed build --force` was a silent no-op (#46).** It called
`warmEmptyRefCache`, which is `ensureEmptyRefCache(build: true)` and returns any
reference already in the store before reaching the builder. So with a live
reference present the command returned in seconds, printed none of the sync it
claimed to have done, and reported `built: true` at the unchanged height. Since a
second archived height can only be gained by advancing the live one, that made
the whole archived-reference feature unreachable from the CLI — and anyone
building on a schedule, which ADR-0003 recommends, would have accumulated nothing
while every run reported success. `--force` now takes the refresh path, and the
command reports `built: false` with a reason when nothing moved rather than
claiming a build. Verified on preview: 419,471 → 518,544 in 71s, both heights
archived.

**The benchmark could not measure the archive it was extended for (#47).** Its
disk overlay whitelisted reference keys by exact match, and archived references
are keyed by height, so they read as absent and every run measured the genesis
path. It reported "no reference at or below birthday" for a birthday that seeds
correctly against the real store. Now matched by prefix; the same case seeds from
the archive and finishes in 70.8s where it previously timed out.

**`wallet generate` recorded no birthday (#48).** Fixed on the CLI and TUI, and
guarded: an AST test now fails any `generate` call omitting the birthday, because
this is the second time the same "whichever surface remembers" hazard has bitten.
The extension's local `chainTip(networkId) => number` is renamed
`chainTipHeight`, since core exports `chainTip(indexerUrl) => {height, timestamp}`
and two same-named functions with different shapes is how an object ends up
stored where a height belongs without a call-site type error.

**The birthday refusal claimed a loss that cannot happen (#49).** It said the
earlier unshielded funds "would not be found", which is false: the unshielded
cursor is keyed by address and a pre-seed never advances it — our
`preSeedNewWallet` does not even carry the field — so those funds are found from
the start whatever the birthday says. The real risk is shielded funds and the
DUST they generate, and that is precisely what no address-based query can check.
The refusal now says what it means: the seed was demonstrably active below the
asserted height, which makes an earlier shielded receive plausible. The check
proves the harmless case in order to warn about the harmful one it cannot see.
Corrected in the refusal, the force warning, the shielded caveat, CLI flag help,
the TUI hint, the extension copy and its three locale translations, and the
README.
