# ADR-0006: Ledger v9 support and selectable signature kinds

- **Status:** Accepted
- **Date:** 2026-08-18
- **Authors:** @bobblessinghartley
- **Reviewers:** TBD
- **Tags:** ledger, cryptography, dependencies, sync

## Context

Midnight is hard-forking the ledger from v8 to v9. The upstream wallet SDK states the
requirement directly ([midnight-wallet#628]): *"Mainnet will hard-fork from ledger-v8 to
ledger-v9, and one SDK release has to run v8 behavior pre-fork and v9 post-fork, switching
automatically mid-sync."*

Moth today pins `@midnight-ntwrk/ledger-v8@8.1.0` in three packages and imports it directly
in ten `packages/core` source files. It has no concept of a ledger version: `NetworkConfig`
is a flat record of URLs, and `SUPPORTED_NETWORKS` is a string list.

Three facts force a decision now rather than at fork time.

**1. v9 is published and the signing types are breaking.** `@midnight-ntwrk/ledger-v9` and
`@midnightntwrk/ledger-v9` both sit at `1.0.0-rc.4` (published 2026-08-10/11). Their
`.d.ts` files are byte-identical; only the package name differs, so they are the same
artifact republished under two scopes. No exports were removed and eleven were added, but
three type aliases changed shape:

| Type | v8 | v9 |
|---|---|---|
| `Signature` | `string` | `{ tag: SignatureKind, value: string }` |
| `SigningKey` | `string` | `{ tag: SignatureKind, value: string }` |
| `SignatureVerifyingKey` | `string` | `{ tag: SignatureKind, value: string }` |

`SignatureKind = 'schnorr' \| 'ecdsa'` is new — BIP-340 Schnorr, or ECDSA over secp256k1.
`SignatureEnabled` gains a `readonly value: Signature`.

This breaks `packages/core/src/wallet/sign-message.ts` silently rather than loudly. It does
`String(keystore.signData(payload))` and `String(keystore.getPublicKey())`. On v8 those are
identity on a `string`; on v9 they stringify an object to `"[object Object]"`. The dApp
connector would return well-formed-looking garbage, and no type error would flag it because
the field is already typed `string`.

**2. The signature kind is chosen at keystore construction, and ECDSA unlocks HSM custody.**
`createKeystore` changed from `(secretKey: Uint8Array, networkId)` to
`(secretKey: { kind: SignatureKind, secret: Uint8Array }, networkId)`. The beta keystore also
adds `signDataAsync`, documented for "out-of-process backends (MPC, HSM)". This matters
beyond protocol compliance: `docs/spec/wallet-service/05-key-management.md` records that
Midnight's Schnorr-over-Pedersen signing is why AWS/GCP KMS and commercial HSMs cannot hold
Midnight keys — they speak secp256k1. ECDSA plus an async signer is the seam that removes
that blocker, so this is a custody feature, not only a fork requirement.

**3. Devnet has already moved.** Indexer-reported `protocolVersion`, sampled 2026-08-18:

| Network | protocolVersion |
|---|---|
| mainnet, preprod, preview, qanet | `1000000` |
| devnet | `2000000` |
| stagenet (node `state_getRuntimeVersion.specVersion`) | `2000000` |

Moth lists devnet as supported and pins v8 against it. **That combination is broken** —
see "Fork incompatibility, measured" below.

Stagenet — the MNF demo network ([stagenet.md]) — runs node `2.0.0-d9729c13`, RPC at
`wss://rpc.stagenet.shielded.tools`, indexer at
`https://indexer.stagenet.shielded.tools/api/v4/graphql`. Moth has no stagenet entry. That
SRE doc was last verified 2026-06-18, before v9 was published, and does not name a ledger
version. Stagenet's `2000000` above is read from the node's `state_getRuntimeVersion`, since
its indexer is still syncing and cannot yet be asked for a block `protocolVersion`.

**4. The fork is a whole-stack move, not just a ledger bump.** The target component set:

| Component | Target | Moth today | Note |
|---|---|---|---|
| Ledger | `9.1.0.0-rc.3` | `ledger-v8@8.1.0` | Component numbering is not the npm version: the npm package is `ledger-v9@1.0.0-rc.4` |
| Node | `2.1.0-alpha.1` | n/a (client) | Stagenet currently serves `2.0.0-d9729c13`, so stagenet is *behind* this target |
| Indexer | `4.4.0-rc.2` | `api/v4/graphql` | Path version unchanged; server version is new |
| Proof Server | `9.0.0-rc.7` | `serverProver()` → `localhost:6300` | Major bump; jumps to the ledger's major |
| Compact toolchain | `0.33.0` | local CLI reports `0.31.1` | |
| Compact runtime | `0.18.0-rc.2` | `compact-runtime@0.16.0` | npm `rc` tag is `0.18.0-rc.1`; `rc.2` not published as of 2026-08-18 |
| Faucet | — | stub | See below |

Two of these are unverifiable from the registry and were taken from the component matrix
supplied for this work: the ledger `9.1.0.0-rc.3` label has no npm counterpart, and
`compact-runtime@0.18.0-rc.2` is one ahead of what npm serves. Both should be confirmed
against the release channel before pinning.

**5. Stagenet needs faucet support, which Moth does not have.** All three stagenet services
are required: `rpc.stagenet.shielded.tools`, `indexer.stagenet.shielded.tools` and
`faucet.stagenet.shielded.tools`. The faucet answered `{"status":"SERVING"}` on
`/api/health` when probed on 2026-08-18. The indexer answered 503 at the same moment because
it is still backfilling — the node was at block 72,037, so this is a network early in its
life, not a broken service. `NetworkConfig` has no faucet field, and
`packages/cli/src/commands/airdrop.ts` is a stub: it hard-rejects any network except devnet,
never calls a faucet, and still reports `status: 'requested'` — it claims success without
doing anything.


## Decision

We will add ledger v9 support to Moth as a **selectable ledger variant alongside v8**, not as
an in-place upgrade, and expose signature kind as wallet configuration defaulting to
`schnorr`.

Specifically:

1. Introduce a ledger-version seam in `packages/core`. The ten files that currently
   `import * as ledger from '@midnight-ntwrk/ledger-v8'` import from an internal module that
   resolves the active version instead. Direct imports of a version-suffixed package outside
   that seam become a lint error.
2. Extend `NetworkConfig` with an explicit ledger/protocol version and an optional
   `faucetUrl`, and add `stagenet` (rpc + indexer + faucet) to `DEFAULT_NETWORKS`.
3. Thread `SignatureKind` through key derivation, keystore construction, and the dApp
   connector's `signData`, defaulting to `schnorr`.
4. Guard rather than prompt for a ledger. The network determines it — devnet *is* v9,
   preprod *is* v8 — so it is not a user preference, and offering the choice at wallet load
   would invite selecting a combination that cannot work. The version is **derived from the
   indexer's reported `protocolVersion`**, with the shipped table as fallback when the
   indexer cannot be reached; a mismatch refuses at sync start *and* at submission, naming
   both sides. Key derivation is unaffected either way: it is fork-invariant
   (`derivation-invariance.test.ts`), so at wallet load there is nothing ledger-specific to
   decide.
5. Expose signature kind wherever a wallet is created — the extension's setup flow and the
   CLI's `wallet generate` / `wallet import` — and refuse ECDSA on a v8 network rather than
   creating a wallet with no unshielded address there.
6. Implement `airdrop` against a real faucet, network-gated by config rather than the
   current hardcoded devnet check, and stop reporting success when nothing was requested.
7. Track the upstream SDK's variant machinery rather than building our own fork-handoff.

Scope limit: this ADR covers Moth running against a v8 *or* a v9 network, selected per
network. It does **not** cover a live mid-sync handoff at the fork block; that follows the
SDK's variant work and is deferred to its own ADR.

## Alternatives considered

### Option A — In-place upgrade to v9, drop v8

- **Summary:** Bump the dependency, fix the compile errors, support only v9.
- **Pros:** Smallest diff; one WASM blob; no abstraction to maintain.
- **Cons:** Abandons mainnet, preprod, preview and qanet, all still on `1000000`. Moth is a
  developer wallet whose value is reaching every network.
- **Why not chosen:** Strands the four networks real users are on.

### Option B — Stay on v8, revisit at fork

- **Summary:** Defer.
- **Pros:** Zero work now.
- **Cons:** Devnet and stagenet are already unreachable-or-unverified; the ECDSA/HSM seam
  stays shut; and the fork lands as a crisis instead of a migration.
- **Why not chosen:** The split already exists, so this is not deferral, it is a known gap.

### Option C — Both ledgers, selected per network (**chosen**)

- **Summary:** Load v8 and v9 side by side, pick per network config.
- **Pros:** Every network stays reachable. Upstream has *proved the mechanism works*:
  [midnight-wallet#629] loads both WASM modules in one process, with five passing tests
  covering distinct class identity, serialize round-trips, and interleaved use with no shared
  global state. The two npm scopes (`@midnight-ntwrk` for v8, `@midnightntwrk` for v9) are
  what make coexistence possible at the package-manager level.
- **Cons:** Two WASM blobs in the bundle — a real cost for `packages/browser` and the
  extension. Objects can never cross the boundary: a v8 `LedgerState` is not an instance of
  `v9.LedgerState`. The seam must be disciplined or the two will get mixed.
- **Verified 2026-08-18:** both *full* stacks — not just the ledgers — resolve in a single
  dependency graph, under npm and under Yarn 4.14.1 (`nodeLinker: node-modules`), using npm
  aliases (`"wallet-sdk-v9": "npm:@midnightntwrk/wallet-sdk@2.0.0-beta.2"`). All thirteen
  `wallet-sdk-*` subpackages coexist, v8 hoisted and v9 nested. See "Single-build
  feasibility" below for what this costs and the traps it surfaced.
- **Why chosen:** It is the only option preserving multi-network reach, and the risky part is
  already de-risked upstream.

### Option D — Two builds, or a runtime-downloaded ledger module

- **Summary:** Ship `moth-v8` and `moth-v9`, or fetch the WASM on demand.
- **Pros:** One blob per artifact.
- **Cons:** Doubles release matrix and support burden; a downloaded consensus-critical WASM
  module is a supply-chain surface we should not open.
- **Why not chosen:** Cost and risk exceed the bundle-size saving.

## Consequences

### Positive

- Moth reaches v8 and v9 networks from one install, including devnet and stagenet.
- ECDSA + `signDataAsync` opens the KMS/HSM custody path that
  `05-key-management.md` documents as blocked.
- The version seam makes the eventual mid-sync fork handoff an implementation behind an
  interface that already exists.

### Negative

- Two WASM modules at 9.9 MB each, plus duplicated `graphql`, `@effect/platform` and
  `@noble/*` trees; browser and extension bundle budgets need re-measuring before this ships
  there. See "Single-build feasibility".
- We depend on release-candidate and beta artifacts (`ledger-v9` at `rc.4`, `wallet-sdk` at
  `2.0.0-beta.2`, `compact-js` at `2.5.5-rc.7`). Both SDK PRs are **open, not merged**, and
  target a `v2` branch.
- The `Signature`-as-object change is silently wrong rather than type-caught at the
  `String(...)` sites, so it needs a deliberate test, not a compiler pass.

### Neutral / follow-up

- `packages/tui` declares `@midnight-ntwrk/ledger-v8` but imports it nowhere — drop it.
- `packages/mock-dapp` imports `Transaction` and `nativeToken` from v8 in a fixture and its
  test; these need the seam or an explicit version pin.
- `SUPPORTED_NETWORKS` and `ALL_NETWORKS` in `wallet/address.ts` are already documented as
  needing manual sync; adding stagenet is a third place to update.

## Dependency map

What pins a ledger version today, and what the v9-era equivalent is:

| Package | Current | Pins | v9-era | Pins |
|---|---|---|---|---|
| `@midnight-ntwrk/ledger-v8` | `8.1.0` (direct) | — | `@midnightntwrk/ledger-v9` | `1.0.0-rc.4` |
| `@midnightntwrk/wallet-sdk` | `1.2.0` | v8 `^8.1.0` | `2.0.0-beta.2` | v9 `1.0.0-rc.3` |
| `@midnight-ntwrk/compact-js` | `2.5.1` | v8 `^8.0.3` | `2.5.5-rc.7` | v9 `^1.0.0-rc.3` |
| `@midnight-ntwrk/midnight-js` | `4.1.1` | no direct ledger dep | `5.0.0-beta.6` | no direct ledger dep |
| `@midnight-ntwrk/dapp-connector-api` | `4.0.1` | no direct ledger dep | — | — |
| `@midnight-ntwrk/zkir-v2` | `2.1.0` | no direct ledger dep | — | — |
| `@midnight-ntwrk/compact-runtime` | `0.16.0` | no direct ledger dep | `0.18.0-rc.2` (target) | unverified on npm |

The transitive pins are the constraint: `wallet-sdk` reaches ledger through
`-facade`, `-shielded` and `-unshielded-wallet`, and the whole set moves together. Moth
cannot mix `wallet-sdk@1.2.0` with v9, nor `2.0.0-beta.2` with v8.

Note the repo-root `resolutions` block pins `@midnight-ntwrk/ledger-v8: 8.1.0` and
`@midnight-ntwrk/compact-js: 2.5.1` workspace-wide; both must change deliberately.

## Affected components

| Area | Files | Change |
|---|---|---|
| Ledger imports | `core/src/{proof/provider,contract/call,contract/deploy,contract/maintenance,types/wallet,daemon/wallet-handlers,wallet/address,sync/wallet-sync,sync/operations}.ts` | Route through the version seam |
| Signing | `core/src/wallet/sign-message.ts` | `createKeystore` shape; drop `String(...)` on `Signature`/`SignatureVerifyingKey`; thread `SignatureKind` |
| Key derivation | `core/src/wallet/{address,keystore,manager}.ts` | Carry signature kind alongside the seed |
| Network config | `core/src/types/network.ts` | Add ledger version; add `stagenet` |
| Proof | `core/src/proof/{provider,client}.ts` | Prover payload versioning is already v8-aware (see the `8.1.0 rejects unversioned circuit-call proofs` comment); re-verify against v9 |
| Connector | `packages/extension`, `packages/browser` | `signData` wire format now carries a kind |
| Surfaces | `packages/cli`, `packages/tui` | Network/kind selection flags; drop tui's unused v8 dep |
| Faucet | `cli/src/commands/airdrop.ts`, `core/src/types/network.ts` | Implement the real request; add `faucetUrl`; drop the hardcoded devnet gate |
| Fixtures | `packages/mock-dapp/src/night-transfer-fixture.ts(+.test)` | Version-pin or route through the seam |

## Fork incompatibility, measured

Cross-decoding real transactions from live networks on 2026-08-18, using both ledger modules
in one process:

| Network | protocolVersion | Transaction wire tag | ledger-v8 | ledger-v9 |
|---|---|---|---|---|
| preprod | `1000000` | `transaction[v9](signature[v1],proof,pedersen-schnorr[v1])` | **decodes** | rejects |
| devnet | `2000000` | `transaction[v12](signature[v2],proof,pedersen-schnorr[v1])` | rejects | **decodes** |

Each rejection is a header-tag mismatch, raised before any structural parsing. Three
consequences:

1. **`protocolVersion` is the ledger generation.** `1000000` is v8 and `2000000` is v9, for
   transactions at least. This is what the network selection can key on.
2. **Moth's devnet support is already broken.** A v8 build against devnet fails on the first
   transaction it meets — it does not degrade, it does not partially work. So the v9 work is
   a *fix* for a network Moth already claims to support, not only preparation for a future
   fork. Preprod and preview are confirmed working on v8, consistent with their `1000000`.
3. **There is no cross-version transaction compatibility in either direction.** #629 declined
   to assert this; measured, it is a clean mutual rejection. Any design that assumed a v9
   build could read pre-fork history, or a v8 build could limp along post-fork, is unsound.

The `signature[v1]` -> `signature[v2]` bump in the tag is the same change as the `Signature`
type going from bare hex to `{tag, value}` — the wire format and the TypeScript type moved
together.

**Not everything forked.** Both zswap and DUST collapsed Merkle updates are tagged
`merkle-tree-collapsed-update[v1]` on both networks, and *both* ledgers decode *both*
networks' updates. Parts of the sync path are format-stable across the fork; transactions are
not. So "does v8 work against devnet" has no single answer — the Merkle sync would proceed
and the transaction handling would fail, which is a worse failure mode than a clean refusal
and an argument for selecting the ledger up front from `protocolVersion` rather than
discovering the mismatch mid-sync.

These tags are pinned in `packages/core/tests/unit/ledger/fork-incompatibility.test.ts`,
asserted through each module's own error message so the test needs neither the network nor
multi-kilobyte fixtures.


## Single-build feasibility

One build can carry both stacks. This was tested, not assumed, on 2026-08-18.

**What resolves.** A probe project depending on both `@midnightntwrk/wallet-sdk@1.2.0` and
`@2.0.0-beta.2` via npm aliases resolves cleanly under both npm and Yarn 4.14.1. All thirteen
`wallet-sdk-*` subpackages appear at both versions (v8 hoisted, v9 nested), alongside
`ledger-v8@8.1.1` and `ledger-v9`. Aliasing is required because the two SDK generations share
package *names* and differ only by version — unlike the ledgers, which differ by npm scope
and coexist naturally.

**What it costs.** Each ledger WASM blob is 9.9 MB (`midnight_ledger_wasm_v9_bg.wasm`;
v8 is the same size). Yarn's fetch step pulled 91.9 MiB for the probe. Duplicated transitive
deps come along too: `graphql` at 16 and 17, `@effect/platform` at 0.95 and 0.96,
`@noble/hashes` at 1.8 and 2.3, `@noble/curves` at 1.9 and 2.3.

For `packages/cli`, `packages/core` and the daemon — Node processes — this is acceptable.
For `packages/browser` and `packages/extension` it is the deciding constraint and must be
measured before either ships dual-stack. Lazy-loading the inactive ledger, or shipping the
browser surfaces single-stack while the CLI carries both, are the obvious escape hatches and
should be decided with numbers in hand.

**Trap found: a naive resolve pulls _three_ ledger blobs, not two.** Yarn resolved
`ledger-v9` at both `1.0.0-rc.3` (exact pin from `wallet-sdk@2.0.0-beta.2`) and `1.0.0-rc.4`
(from `compact-js@2.5.5-rc.7`'s `^1.0.0-rc.3`) — ~29.7 MB of WASM instead of ~19.8 MB, and
two *distinct* v9 module identities that would fail the same `instanceof` checks that
separate v8 from v9. The v9 ledger must be pinned to exactly one version, tree-wide.

**Trap found: the root `resolutions` block.** `package.json` pins
`@midnight-ntwrk/compact-js: 2.5.1` and `@midnight-ntwrk/ledger-v8: 8.1.0` workspace-wide.
Resolutions are global by package name, so they interact badly with a deliberate two-version
tree and must be re-scoped or removed as part of this work.

**Out of process, so not a bundling question at all.** The proof server (`9.0.0-rc.7`) and
indexer (`4.4.0-rc.2`) are network services, not bundled dependencies. Supporting both
generations there is per-network configuration — a `prover` URL and an `indexerUrl` each
network already carries — plus running a v8 and a v9 proof server side by side in dev. No
single-build tension exists for these two; the tension is entirely in the WASM-linked
libraries.


## What implementation found

The seam was necessary but not sufficient. Its static types are v8's, so every remaining
v8/v9 difference was invisible to the compiler and surfaced only by running the wallet
against devnet. Five did:

| Contract | v8 | v9 | Symptom |
|---|---|---|---|
| `createKeystore` | `(secret, networkId)` | `({kind, secret}, networkId)` | throws on v9 |
| `SignSegment` | `(data) => Signature` | `(data) => Promise<Signature>` | "Signer callback failed" |
| `ProvingProvider` | `{check, prove}` | adds `lookupKey` | "expected proving provider property 'lookupKey'" |
| `Signature` | hex string | `{tag, value}` | `String()` yields `"[object Object]"` |
| WASM proving keys | — | version-specific | v8 keys proved against a v9 chain |

The last was ours, not the SDK's: the key-material provider was cached in a bare singleton,
so the first network a session touched decided which proving keys every later network got.

Two further faults came from threading `SignatureKind`, not from the fork. The kind reached
address derivation but not sync, so an ECDSA wallet displayed one address and watched
another — reporting a zero balance while its funds sat on chain. And cached unshielded state
embeds the key it was watching, so fixing the derivation was not enough: the cache had to be
namespaced by kind or the wallet restored the wrong view.

The lesson worth carrying: **schnorr paths bypass the seams entirely**, so any check run with
a schnorr wallet proves nothing about the ECDSA path. Both need exercising.


## Validation

- **Success criteria:** Moth derives addresses, syncs, and submits a transfer on a
  `1000000` network and on devnet/stagenet from one build; a `signData` round-trip verifies
  under both `schnorr` and `ecdsa`; both ledger modules coexist in one process without
  cross-contamination, mirroring [midnight-wallet#629].
- **Failure signals:** the two WASM blobs breach browser/extension bundle budgets; v9 rc
  churn breaks us more than once per release; or the SDK's variant work lands with a shape
  that makes our seam redundant *and* incompatible.
- **Review date:** when `wallet-sdk@2.x` and `ledger-v9@1.0.0` reach stable, or 2026-10-31,
  whichever is first.

## Open questions

1. ~~Does `protocolVersion 2000000` mean ledger v9?~~ **Answered:** yes, for transactions —
   see "Fork incompatibility, measured". Note the SDK still keeps the fork version out of its
   own code ([midnight-wallet#628] calls it "not-yet-final"), so this mapping is measured
   behavior, not a published constant, and should be re-checked if the tags move.
2. ~~Does Moth's v8 stack still work against devnet today?~~ **Answered:** no. Transactions
   fail on a header-tag mismatch. Preprod and preview work, matching their `1000000`.
3. ~~Cross-version state compatibility~~ **Partly answered:** transactions are mutually
   unreadable; collapsed Merkle updates are shared. Whether *commitments and token types*
   match across versions is still open and still belongs to the ledger team.
4. ~~Proof server and indexer compatibility with v9~~ **Answered for both:** the `api/v4`
   contract is unchanged, and a proof server works against devnet. WASM proving is still
   failing there and is the one open defect.
5. **Which ledger-v9 scope to depend on** — `@midnight-ntwrk` or `@midnightntwrk`. Identical
   content; the beta SDK uses the unscoped-dash form, so matching it avoids a duplicate blob.
6. **When does stagenet's indexer finish syncing?** It is backfilling (503 as of
   2026-08-18, node at block 72,037) while node and faucet are healthy. Sync work against
   stagenet is blocked until it serves, and until then its block `protocolVersion` — the
   signal the SDK's fork detection keys on — cannot be confirmed from the indexer.
7. **Ledger version labelling** — the component matrix says `9.1.0.0-rc.3` but npm publishes
   `ledger-v9@1.0.0-rc.4`. Which is authoritative for pinning, and do they correspond?
8. **Does stagenet need to reach node `2.1.0-alpha.1` first?** It serves `2.0.0-d9729c13`
   today, below the target, so it may not yet exercise the stack we are building for.
9. **Faucet API contract** — only `/api/health` is confirmed. The request endpoint, auth,
   rate limits and response shape are unknown.

## References

- Related ADRs: [ADR-0003](0003-preseed-reference.md), [ADR-0005](0005-preseed-for-cli-tui.md)
- [midnight-wallet#628] — variant activation hook; states the hard-fork requirement
- [midnight-wallet#629] — proves v8/v9 WASM coexistence in one process
- `docs/spec/wallet-service/05-key-management.md` — why HSMs cannot hold Midnight keys today
- [stagenet.md] — stagenet environment reference (SRE, last verified 2026-06-18)

[midnight-wallet#628]: https://github.com/midnightntwrk/midnight-wallet/pull/628
[midnight-wallet#629]: https://github.com/midnightntwrk/midnight-wallet/pull/629
[stagenet.md]: https://github.com/shieldedtech/shielded-sre-agent-docs/blob/cdc7d6c838b502c3d5aee7ab4a8e161b00772992/docs/environments/stagenet.md
