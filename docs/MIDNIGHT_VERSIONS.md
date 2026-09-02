# The Midnight version train

Midnight's compiler, runtime and SDK are not independently versioned components.
They are one set that moves together. `midnight-versions.json` at the repo root
declares that set, and four gates keep the repo consistent with it.

Read this before changing any `@midnight-ntwrk/*` or `@midnightntwrk/*` version.

## Why exact pins, and why this is not over-engineering

Ordinary semver reasoning is actively wrong for part of this dependency set.

Several of these packages are WASM-backed. A caret range is *supposed* to mean
"any API-compatible version" — but two API-compatible copies of a WASM module
are two distinct module instances, so a value built by one fails the other's
`instanceof` check. There is no range syntax that expresses "exactly one copy",
which is why every single-instance package is pinned exactly and verified in the
resolved tree, not just in the manifests.

The failure mode is the nasty kind: install succeeds, types check, the contract
*deploys* fine, and then the first circuit call fails with
`expected instance of StateValue`.

That is not hypothetical — it is how we lost time on M1. Three separate
failures, all version skew, no logic bugs:

| symptom | cause |
|---|---|
| `npm install` fails outright | `compact-js@2.5.3` requires `@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`; ledger-v9 exists only at `1.0.0-rc.x`, so the range is unsatisfiable. 2.5.3 looks like a patch but is a ledger-v9 prerelease. |
| deploy succeeds, `call` fails with `expected instance of StateValue` | `compact-runtime@0.16.0` accepts `onchain-runtime-v3@^3.0.0` and floated to `3.1.0`, while `midnight-js-protocol@4.1.1` pins `3.0.0` exactly. Two WASM modules loaded. |
| artifacts demand a runtime the SDK will not install | compiler `0.34.0` emits `checkRuntimeVersion('0.19.0')`, but `midnight-js-protocol@4.1.1` pins `compact-runtime` to exactly `0.16.0`. Compiler `0.31.1` is the one that emits `0.16.0`. |

The lesson from the third row is the one to remember: **on Midnight you pick the
compiler that matches your SDK, not the newest one.**

## The compiler is not an npm dependency

This is the part nothing else in the repo could pin. `compact` is a separate
binary with its own installed toolchains, and its artifacts embed the runtime
version they demand. So `midnight-versions.json` carries `compiler` and
`languageVersion` alongside the npm pins, and `yarn compile:contracts` selects
the toolchain explicitly with `compact +<version>`.

Two consequences worth knowing:

- Compiler `0.31.1` caps the language version at `0.23.0`. The contracts'
  `pragma language_version >= 0.23` is deliberate — do not "modernize" it to a
  newer language version while the compiler is pinned here.
- Upgrading to compiler `0.34.0` means `compact-runtime@0.19.0`, which depends
  on `@midnightntwrk/onchain-runtime-v4` — a different npm scope, published only
  as `4.0.0-rc.x` — and therefore `midnight-js` `5.0.0-beta.x`. That is a whole
  train move, not a compiler bump.

## The four gates

| gate | command | catches |
|---|---|---|
| Manifests | `yarn constraints` | a caret range, or an `@midnight*` package no one added to the train, in any workspace |
| Resolved tree | `yarn check:versions` | duplicate WASM instances an upstream caret smuggled in |
| Artifacts | `yarn check:versions` | a contract compiled by the wrong compiler or against the wrong runtime |
| Templates & resolutions | `yarn check:versions` | scaffolding templates and root `resolutions` drifting from the train |

`yarn constraints` sees only workspace manifests; everything outside them is
`scripts/check-midnight-versions.mjs`. Both run in CI on every PR.

Note that root `resolutions` must be literal in `package.json` — Yarn cannot
compute them from the train at install time. So they are *verified* against the
train rather than derived from it. Adding a package to `singleInstance` without
a matching `resolutions` entry fails the gate.

## Upgrading

Upgrade the train, never a single package. A one-package bump is what produced
all three failures above.

```sh
# 1. Edit midnight-versions.json — compiler, languageVersion and npm together.
#    Check the new SDK's own pins first:
npm view @midnight-ntwrk/midnight-js-protocol@<new> dependencies

# 2. Propagate to every workspace manifest.
yarn constraints --fix
yarn install

# 3. Rebuild contract artifacts with the newly pinned compiler.
compact update <new-compiler>   # if not already installed
yarn compile:contracts

# 4. Verify, then exercise it for real — a clean install and type-check do NOT
#    prove the WASM instances agree.
yarn check:versions
yarn test
```

Step 4's last point is the whole reason this document exists: the duplicate-WASM
failure is invisible to `yarn install`, `tsc` and `yarn constraints` alike. Only
an actual circuit call proves it.

### Do not trust version numbers

`compact-js@2.5.3` is a prerelease wearing a patch-release number. No automated
range can tell you that. Exact pins plus a human reading the
`midnight-versions.json` diff is the only real defense, so keep train bumps in
their own commit where they are easy to review.

## Registry

All `@midnight-ntwrk/*` and `@midnightntwrk/*` packages are on public npm. Do not
add `.npmrc` or `.yarnrc.yml` registry overrides — a previous
`npmScopes.midnight-ntwrk` entry was removed because it merely restated the
default registry while implying a policy it did not enforce (it did not cover the
hyphenless `@midnightntwrk` scope that the wallet SDK ships under).

## Known gap

`packages/cli/templates/dapp/api/package.json` still contains a
`{{API_PACKAGE_NAME}}` placeholder, and nothing in this repo substitutes template
placeholders yet. Its *dependency* versions are now concrete and gated, but the
template is not yet renderable — wiring up a scaffolder is separate work.
