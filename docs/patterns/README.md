# Building a Midnight wallet: patterns from Moth

This is a field guide for anyone implementing a wallet on the Midnight Network.
It captures the **non-obvious** patterns and gotchas Moth settled on — the
decisions that aren't in the SDK docs and that cost real debugging to get right.
Each section links to the working code so you can read the exact implementation.

> Ground rule while reading: trust the linked code, not folklore. The Midnight
> SDK moves fast and API details drift; the file references below are the source
> of truth for *this* codebase and were green at the time of writing.

New to Midnight from Zcash, Monero or general ZK-wallet work? Start with
**[what's familiar and what isn't](./midnight-wallet-characteristics.md)** — the
shielded layer will feel like home, and the fee layer is where the intuitions
mislead. It accounts for 99% of sync time and is immune to every light-client
trick those chains rely on.

Contents:
1. [Key management: derive-and-drop](#1-key-management-derive-and-drop)
2. [The WASM-serialization boundary](#2-the-wasm-serialization-boundary)
3. [Proving: selectable WASM vs server](#3-proving-selectable-wasm-vs-server)
4. [Browser-safe core](#4-browser-safe-core)
5. [The sync engine](#5-the-sync-engine)
6. [Submission and transaction identity](#6-submission-and-transaction-identity)
7. [DUST](#7-dust)
8. [MV3 extension architecture](#8-mv3-extension-architecture)
9. [Contracts](#9-contracts)
10. [Multi-output send](#10-multi-output-send)
11. [i18n discipline](#11-i18n-discipline)

---

## 1. Key management: derive-and-drop

**Pattern.** Derive a typed key bundle once, immediately drop the raw seed, and
pass the bundle — never the seed — through the rest of the system.
`deriveWalletKeys(seedHex)` returns `{ shieldedSecretKeys, dustSecretKey,
nightExternalKey }`; the local `seedHex` reference is dropped (`seedHex = ''`)
right after.

**Caveat — you drop the reference, you don't scrub the bytes.** `seedHex` is a
JavaScript string, and strings are immutable: `seedHex = ''` only releases *this*
binding — it can't overwrite the characters, which linger in the heap until the
GC happens to reclaim them. (The raw seed *bytes* from `mnemonicToSeed` are a
`Uint8Array` and *are* zeroed with `seed.fill(0)`; the hex- and mnemonic-*string*
forms cannot be.) In the browser extension the seed necessarily stays resident
for the whole session (§2). So treat "drop the seed" as a scope/lifetime
discipline — no live reference survives past `unlock` / the key-holder — not as
cryptographic zeroization of the plaintext.
- `deriveWalletKeys` — `packages/core/src/sync/operations.ts:81`
- `WalletManager.unlock` derives the bundle and never puts the seed on the
  returned `UnlockedWallet` — `packages/core/src/wallet/manager.ts` (see the
  `walletKeys` field and the `seedHex = ''` after derivation).

**Why.** Every Midnight write path (transfer, DUST designation, contract call)
accepts the typed keys directly, so there's no reason to keep the seed live. In a
multi-tenant daemon this is a hard security boundary: the seed exists only inside
`unlock` and never enters RPC/messaging.

**Gotcha.** Make the invariant *type-level*: don't expose `seedHex` on the
unlocked-wallet type at all, or callers will quietly depend on it. When we first
migrated the extension, one call site still read `unlocked.seedHex` (now
`undefined`) and it surfaced to users as "wrong password." See
`docs/spec/wallet-service/05-key-management.md` (D-KM-3) for the full spec.

## 2. The WASM-serialization boundary

**The single most subtle thing in a browser wallet.** The typed key bundle from
§1 is backed by WASM objects (`ZswapSecretKeys`, `DustSecretKey`). **WASM objects
cannot cross a process or document boundary** (Chrome runtime messages,
structured clone, web-worker postMessage). Only plain serializable data — like
the hex seed — can.

**Consequence.** Wherever the key-holder is a *separate, restartable context*
from the UI (an MV3 offscreen document, a worker, a daemon socket), you cannot
ship the keys across. You ship a serializable secret (the seed) to the
key-holder, and it re-derives the bundle locally, then drops the seed (§1).

- Moth's core `unlock` is seed-free by design (§1), so the extension recovers a
  serializable seed through an explicit, single-purpose method:
  `WalletManager.exportSeedHex` — `packages/core/src/wallet/manager.ts:312`.
- The offscreen key-holder derives once per session and reuses it:
  `syncEnsure` / `activeWalletKeys` — `packages/extension/lib/offscreen/wallet-host.ts`.

**Gotcha.** The offscreen document is ephemeral — Chrome tears it down at will —
so the background must be able to *re-supply* the seed on each restart. That's
why the seed reaches the offscreen at all; keep it out of everything downstream.

## 3. Proving: selectable WASM vs server

**Pattern.** Support both local WASM proving and a remote proof server behind one
factory, chosen per network config.
- `createProvingProvider` / `createProofProvider` — `packages/core/src/proof/provider.ts:61`–`72`.

**"Local" WASM proving is not offline.** WASM proving removes the dependency on a
*proof server* — not the dependency on the network. The default key-material
provider (`WasmProver.makeDefaultKeyMaterialProvider`, used by both
`createProvingProvider`'s WASM path and `createWalletProvingService`) lazily
fetches the per-circuit prover/verifier/ZKIR key files and the BLS parameter
blobs over HTTPS from an external fileshare (a Midnight-hosted S3 bucket) on
first use, retrying with backoff and caching them in memory for the process.
There is **no local fallback** — if that server is unreachable, proving fails
once the retries are exhausted. Budget for that first-use network round-trip (and
that outage mode) even on the "local" path.

**Gotcha (this one bites hard).** A circuit call fails with
`expected proof-preimage-versioned` if you hand the ledger a **hand-rolled proof
provider that POSTs the bare preimage**. The payload must be *versioned*. Route
proving through the SDK's proving provider and the ledger's `transaction.prove()`
(which runs `createProvingPayload`/`createCheckPayload` and attaches the circuit
ZKIR) — do not reimplement the POST. `createProofProvider` does this for both
modes; the server path goes through `httpClientProvingProvider` → `prove()`, not
a raw fetch.

## 4. Browser-safe core

**Pattern.** The core library is consumed by Node (CLI/TUI/daemon) *and* bundled
for the browser (extension). Keep the shared modules free of static `node:*` /
`ws` imports and top-level side effects.
- Node-only bits load through a **variable specifier** dynamic import so bundlers
  can't follow them into the browser build:
  `await import(/* @vite-ignore */ specifier)` — `packages/core/src/sync/wallet-sync.ts:74` (WebSocket polyfill) and `:295` (fs-backed store).
- Persistence hides behind an async `SyncStateStore` interface with a
  runtime-resolved implementation (IndexedDB in the browser, fs under Node):
  `resolveSyncStore` — `packages/core/src/sync/wallet-sync.ts:287`.

**Gotcha.** A single static `import 'node:fs'` (or a helper that transitively
pulls one in) breaks the browser bundle. When we reconciled branches, a stale
`node:fs`-based cache helper slipped in and had to be rewritten to the dynamic
pattern. Any node-only function that must stay callable from browser code should
`if (typeof process === 'undefined' || !process.versions?.node) return;` and put
the fs work behind the dynamic import (see `removeWalletSyncArtifacts`).

## 5. The sync engine

**SDK dedup.** The wallet SDK can insert commitment-tree items non-linearly and
throw "values inserted non-linearly into the commitment tree." Wrap the shielded
and DUST sub-wallet builders with deduping builders:
- `dedupingShieldedBuilder` / `dedupingDustBuilder` — `packages/core/src/sync/sdk-dedup.ts:127`/`:153`, wired at `wallet-sync.ts:461`/`:507`.

**Submitted-only submission.** By default the facade resolves a submit only at
*Finalized* (12–60 s+). In an MV3 extension the runtime message port can't outlive
that wait — it closes, the UI sees "No response," and shows a failure even though
the tx landed. Resolve at *Submitted* instead and let normal sync reflect
inclusion:
- `makeSubmittedOnlySubmissionService` — `packages/core/src/sync/wallet-sync.ts:53`, wired at `:540`.

**Pre-seed at tip.** New wallets don't need a genesis scan. Sync one empty
reference wallet to chain tip per network, then clone its state snapshot with the
new wallet's keys swapped in. On preprod this is 78.6 min → ~103s, and dust is
99.2% of what it removes.

**→ [Pre-seeding: syncing in seconds instead of an hour](./preseed-sync-acceleration.md)**
— the full technique, the safety rules, and the verification. Read the safety
section before implementing: done without the `height <= birthday` guard, this
silently hides users' funds.

## 6. Submission and transaction identity

**Retry classification.** Not every submit error means failure. Classify:
- `1013 "already imported"` → the tx is already in the pool: **success**. Read
  the hash via `transactionHash()`; don't resubmit.
- transient (e.g. "WebSocket is not connected") → retry with backoff.
- deterministic node rejection (e.g. `1010 Invalid Transaction`) → throw
  immediately; resubmitting identical bytes yields the same verdict.
- `isAlreadyImported` / `isTransient` / `submitWithRetry` —
  `packages/core/src/sync/operations.ts:109`/`:121`/`:138`.

**Pending ↔ applied reconciliation.** A finalized transaction has a fixed hash,
so record **both** the submission hash and the ledger `transactionHash()` on the
optimistic pending row. The applied chain entry is matched by `transactionHash`,
so the pending row is *replaced* rather than showing as a duplicate.

## 7. DUST

DUST is the fee token; you don't transfer it, you *generate* it by registering
(designating) NIGHT UTXOs.
- **Balance-to-zero during registration.** While a designation is in flight the
  SDK books the NIGHT inputs, so a naive balance read shows 0 tNIGHT. Count only
  *booked* pending inputs (never incoming) so the displayed balance stays honest.
- **Register vs deregister** are distinct flows; DUST already generated keeps
  paying fees after deregistration but stops refilling.
- **View healing.** A DUST view can stop ingesting generation records for newer
  NIGHT UTXOs. Offer a targeted repair that clears *only* the dust sub-wallet
  cache and re-syncs it from chain, keeping the (much larger) shielded/unshielded
  caches — `clearDustSyncCache` (`packages/core/src/sync/wallet-sync.ts`).
  If you also pre-seed, make the seeding decision **per sub-wallet**: gating it on
  the shielded cache means this repair re-walks dust from genesis while a usable
  reference sits unused — so the narrow fix ends up slower than a full wipe.
  See [pre-seeding](./preseed-sync-acceleration.md#rule-5--seed-per-sub-wallet-not-all-or-nothing).

## 8. MV3 extension architecture

- **Offscreen document = WASM host + key-holder.** The service worker can't hold
  long-lived WASM/state; the offscreen document runs the sync engine and proving.
  The background owns session + settings and relays messages.
  - `packages/extension/lib/offscreen/wallet-host.ts`, `lib/background/`.
- **Ephemeral lifecycle** drives the §2 seed re-supply.
- **Auto-lock** via `chrome.alarms` with a demo mode that never locks; never lock
  mid-operation (defer while a tx/approval is in flight) — `lib/background/auto-lock.ts`, `handlers.ts`.
- **Approvals and user activation.** Open the side-panel approval *before* the
  triggering click's user-activation expires, or the browser refuses to open it.

## 9. Contracts

- **`findDeployedContract` over `submitCallTx`.** The latter doesn't honor
  `initialPrivateState` and throws "No private state found at private state ID."
  `findDeployedContract` writes the initial private state before returning a
  call handle — `packages/core/src/contract/call.ts`.
- **WASM class identity across dependency trees.** `compact-js` may build WASM
  objects from one copy of the runtime while the contract module validates them
  against another (`_assertClass` fails, CWE-706). Bridge by
  serialize/deserialize across the trees — see `contract/deploy.ts`.
- Normalize user args to positional form (`toPositionalArgs`), and preflight the
  prover (§3) before building.

## 10. Multi-output send

One transaction can carry several transfer lines — different tokens to different
recipients, shielded and unshielded mixed — with a single combined DUST fee.
Group outputs by kind and build one atomic tx:
- `combinedTransfers` — `packages/core/src/sync/operations.ts:41`.

Record an output count on the activity entry so a batch reads "Sent N transfers"
rather than misrepresenting itself as a single send.

## 11. i18n discipline

If the wallet ships in more than one language, enforce it mechanically:
- A typed `t(key, substitutions)` over a per-area message catalog, with a
  generated `_locales/en` catalog and shipped translations —
  `packages/extension/lib/i18n/index.ts:21`, `lib/i18n/messages/`.
- A **guard test that fails CI on any hard-coded UI string** —
  `packages/extension/tests/no-hardcoded-strings.test.ts` (documented in
  `packages/extension/README.md`). This is what keeps English literals from
  creeping back in as features land.

---

## See also

- `docs/spec/wallet-service/` — the daemon/wallet-service spec (key management,
  authz, approval pipeline, threat model).
- `RECONCILIATION.md` — how the current tree was assembled from feature branches,
  and which approach won each decision (useful context for *why* the code looks
  the way it does).
