---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-tui': patch
'@shieldedtech/moth-cli': patch
---

Pin the Midnight toolchain and SDK as one version train, and gate it in CI.

Midnight's compiler, runtime and SDK are not independently versioned — they are
one set that has to move together. Until now this repo's version of that set was
spread across five unlinked places: each workspace's `dependencies`, the root
`resolutions`, the committed contract artifact's `contract-info.json`, the
Compact compiler (which is not an npm dependency at all, just whichever binary
`compact` happened to have active), and the DApp scaffolding template. Nothing
connected them and nothing checked them, so skew was only discoverable by
hitting it at runtime.

Ordinary semver reasoning is actively wrong for part of this set. Several of
these packages are WASM-backed, and a caret range — which correctly means "any
API-compatible version" — admits two API-compatible copies of a WASM module.
Those are two distinct module instances, so a value built by one fails the
other's `instanceof` check. No range syntax can express "exactly one copy". The
result is the worst kind of failure: install succeeds, types check, the contract
*deploys*, and then the first circuit call fails with
`expected instance of StateValue`.

That is exactly what happened during M1, three times over, all version skew and
no logic bugs: `compact-js@2.5.3` is unrestorable because it asks for
`ledger-v9@^0.1.0-alpha.1` while ledger-v9 exists only at `1.0.0-rc.x`;
`compact-runtime@0.16.0`'s `onchain-runtime-v3@^3.0.0` floated to `3.1.0` while
`midnight-js-protocol@4.1.1` pins `3.0.0` exactly, loading two WASM modules; and
compiler `0.34.0` emits artifacts demanding `compact-runtime@0.19.0` when the
SDK pins `0.16.0` — compiler `0.31.1` is the one that matches.

`midnight-versions.json` is now the single source of truth, carrying the
compiler and language version alongside the npm pins so the compiler is pinned
too. Four gates run on every PR: `yarn constraints` (Yarn 4 constraints, via
`yarn.config.cjs`) rejects a caret range or an `@midnight*` package nobody added
to the train in any workspace manifest, and `yarn check:versions` covers what
constraints structurally cannot see — duplicate WASM instances in the resolved
tree, contract artifacts built by the wrong compiler, root `resolutions` that
have drifted, and scaffolding templates left on stale versions.

No dependency actually changes version here. `@midnightntwrk/wallet-sdk` moves
from `^1.2.0` to `1.2.0` in `core` and `tui`, which is what it already resolved
to, and the four `{{SDK_*_VERSION}}` placeholders in the DApp API template —
which nothing in this repo ever substituted, so a scaffolded project would have
failed to install — are replaced with the pinned versions. Upgrade guidance,
including why the contracts' `pragma language_version >= 0.23` must stay put
while compiler `0.31.1` is pinned, is in `docs/MIDNIGHT_VERSIONS.md`.
