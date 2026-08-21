---
"@shieldedtech/moth-wallet": minor
"@shieldedtech/moth-cli": minor
---

Move a pre-seed reference between machines: `moth preseed export` / `import`.

Building a reference IS the chain walk — tens of minutes, once per network per
machine. That cost is identical for everyone, because a reference holds public
chain state and nothing else, so it is work that should be done once and shared
rather than repeated by every developer who clones the repo. ADR 0005 called for
these two actions; the rest of the command shipped without them.

The on-disk shape is the one `scripts/export-preseed.mjs` already writes and CI
already publishes: gzipped state per sub-wallet plus a manifest. One format, so a
reference exported here can be dropped into the extension package, and one
downloaded from a release can be imported here.

`export` never writes the reference wallet's mnemonic. That is the only secret in
the arrangement — the state blobs are public chain data, but the mnemonic
controls the wallet they were built from, and a published reference is meant to
be safe to hand to strangers. The command says so in its own output.

`import` refuses rather than guesses. A bundle for another network would seed
wallets from a chain they have never been on, and the mismatch is silent
afterwards. A bundle older than what is already present is a downgrade that costs
catch-up time on every wallet created from then on; `--force` allows it, for
replacing a corrupt newer reference with a known-good older one.

Every part is decompressed before any part is written. Unpacking as it went left
the store holding new shielded and unshielded state beside an old dust state when
a later part turned out to be corrupt — a mixture that never existed on chain,
with a height key that still looked consistent. The height is written last, since
it is what marks a reference usable.
