---
"@shieldedtech/moth-wallet": minor
"@shieldedtech/moth-extension": minor
"@shieldedtech/moth-cli": minor
"@shieldedtech/moth-browser": minor
"@shieldedtech/moth-tui": minor
---

Rename the project from Dusk to Moth.

Deliberately a minor bump rather than a major one. A major signals a breaking
change to existing consumers, and there are none: nothing was ever published to
npm under either name, so `@shieldedtech/moth-*` is not a rename of a published
package but the first version of a new one. Changesets promotes a major on a 0.x
package straight to 1.0.0, and 1.0.0 would claim a stability this wallet does
not have — the README calls it experimental and unsupported, and the default
network is preprod precisely because it is unaudited.

Dusk Network is an established layer-1 blockchain whose pitch — privacy-
preserving, zero-knowledge smart contracts — is the same sentence you would use
for Midnight. It ships its own wallet, and its token ticker is DUSK. So "Dusk
Wallet" did not merely resemble their brand; by ordinary naming convention it
read as *their* wallet. The sharpest edge was that this wallet displays a
**DUST** balance: one letter from their ticker, in a balance list, in an
application called Dusk.

Done before publication deliberately. Nothing is on npm, there is no Chrome Web
Store listing and no release tag, so the identifiers that would otherwise have
been permanent are still free to change — above all `WALLET_RDNS`, which dApps
match on to discover the wallet, and which could not be changed after third
parties integrated without breaking every one of them.

Packages are now `@shieldedtech/moth-*`, the CLI binary is `moth`, environment
variables are `MOTH_*`, and the connector identifies as `io.shielded.moth`.
Command names are untouched: none of them contained the old name, and the `dust`
topic is the DUST token, which is Midnight's vocabulary rather than ours.

**The state directory moved from `~/.dusk` to `~/.moth` with no migration
shim.** Anyone with existing CLI or TUI wallets must move it by hand:

```
mv ~/.dusk ~/.moth
```

A fallback that read the old path would have to stay forever to be worth having,
and a project with no published release has no installed base to protect.

The bundled demo token contract is renamed too, `dusk-ft` to `moth-ft`, and
recompiled — prover keys, verifier keys and zkir regenerated from source. Its
domain separator changes with it, from `pad(32, "dusk:ft:")` to
`pad(32, "moth:ft:")`. That is a cryptographic constant, not a label: it colours
every token the contract mints, so the old brand would otherwise have been
visible on-chain in the token type forever. Tokens minted under the old
separator are a different token type and are not reachable from the new build,
which is acceptable only because this is a demo contract that has never run
anywhere but a test network. The execution harness asserts the separator, so the
two cannot drift apart.

`CHANGELOG.md` keeps the old name throughout: it says what the packages were
called when those entries were written, because that is what a changelog is for.
