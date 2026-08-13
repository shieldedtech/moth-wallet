# SDK Duplication Audit — 2026-05-21

Audit of `@moth/*` packages vs. the `@midnight-ntwrk/wallet-sdk-*` packages,
identifying duplication, dead code, and genuine SDK gaps. Includes the per-finding
decisions taken during interactive triage and the resulting code changes.

- **SDK source of truth:** `/Users/xhon/Sites/shielded/wallet-3` (yarn monorepo of
  `@midnight-ntwrk/wallet-sdk-*` and `@midnight-ntwrk/midnight-js-*` packages).
- **Consumer:** this repo (`moth-wallet`), workspaces `core`, `cli`, `browser`, `tui`.

## TL;DR

- Removed ~864 LOC of duplication, dead adapters, and stub commands.
- Consolidated HD derivation, mnemonic handling, and contract-call submission
  onto SDK-provided primitives.
- Dropped direct dependency on `@scure/bip32` (now consumed transitively via
  `@midnight-ntwrk/wallet-sdk-hd`).
- Added direct dependency on `@midnight-ntwrk/wallet-sdk-node-client` for
  contract-call tx submission, replacing the hand-rolled SCALE codec.
- Fixed a latent path-resolution bug in `contract/call.ts`'s ZK config provider
  (replaced with the SDK's `NodeZkConfigProvider`).
- Documented (with TODOs) two known-broken stubs (`moth mint`,
  `TransactionBuilder`) instead of deleting — they remain non-functional pending
  a facade-aware rewrite.
- Identified five legitimate SDK gaps that `@moth/core` still fills (kept
  intentionally; see "SDK gaps" below).

## Findings & decisions

| # | Finding | Decision | Status |
|---|---|---|---|
| 1 | `wallet/hd.ts` — parallel HD derivation via `@scure/bip32` (PURPOSE=44, COIN_TYPE=2400, same `m/44'/2400'/…` tree as the SDK) | Delete `hd.ts`; consolidate on `HDWallet.fromSeed(...)` from `@midnight-ntwrk/wallet-sdk-hd` (already used in 5 other files). Drop `@scure/bip32` direct dep. | done |
| 2 | `wallet/mnemonic.ts` — `generateMnemonic24`/`validateMnemonic` duplicate the SDK; `sync/preseed.ts` had a second direct `@scure/bip39` import | Hybrid: route `generateMnemonic24` + `validateMnemonic` through `@midnight-ntwrk/wallet-sdk-hd`; keep `mnemonicToSeed` as a one-line wrapper (SDK gap — `wallet-sdk-hd` does not expose a `mnemonic → seed` helper). Consolidate `preseed.ts`'s direct BIP39 calls through `mnemonic.ts`. | done |
| 3a | `providers/public-data-provider.ts` — adapter wrapping local `IndexerClient`; bypassed by `indexerPublicDataProvider` in deploy + call (since d4a9b42 / 8779872) | Delete file; remove from `providers/index.ts` and `core/src/index.ts` barrels. Zero callers. | done |
| 3b | `providers/proof-provider.ts` — adapter wrapping local `ProofClient`; the `createCheckPayload`/`createProvingPayload` helpers are no-op stubs | Delete file; remove from barrels. Zero callers. | done |
| 3c | `providers/zk-config-provider.ts` — duplicates `NodeZkConfigProvider`. Latent path-resolution bug: prepended an extra `'managed'` segment when `call.ts` passed it the managed dir directly | Replace `call.ts:93` usage with `new NodeZkConfigProvider(artifactPath)` (same pattern `deploy.ts` already uses). Delete the local file. Fixes the latent bug and removes the duplicate. | done |
| 4 | `cli/src/adapters/fs-storage.ts` — near-verbatim copy of `core/src/storage/fs-adapter.ts` (CLI was importing the type from `@moth/core` but redefining the impl) | Delete CLI duplicate; update `base-command.ts` to import `FilesystemStorageAdapter` from `@moth/core`. Core's version is also marginally safer (uses `safePath()` on `list()` prefix). | done |
| 6 | `network/scale.ts` (~105 LOC SCALE codec) + `JsonRpcNodeClient.submitTransaction` — hand-rolled extrinsic submission to avoid `@polkadot/api`. `@polkadot/api` was already transitive via `wallet-sdk-facade` | Partial migration: rewrite `providers/midnight-provider.ts` to use `PolkadotNodeClient.sendMidnightTransactionAndWait(serialized, 'Submitted')` from `@midnight-ntwrk/wallet-sdk-node-client`. Strip `submitTransaction` from `JsonRpcNodeClient` (now read-only chain status). Delete `scale.ts` + its tests. Added `@midnight-ntwrk/wallet-sdk-node-client@1.1.1` as a direct dep. | done |
| 7 | `Roles` constant defined twice — locally in `wallet/hd.ts` and re-exported from SDK in `wallet/address.ts` | Resolved with #1 — the local `Roles` is gone; `core/src/index.ts` now re-exports the SDK's `Roles` via `wallet/address.ts`. | done |
| 8a | `sync/engine.ts` — `SyncEngine` class with zero production callers (real sync goes through `WalletFacade.state()` Observable in `wallet-sync.ts`) | Delete file + barrel re-exports in `core/src/index.ts` and `browser/src/index.ts`. | done |
| 8b | `wallet/balance.ts` + `cli/commands/balance.ts` — the `moth balance` command is a hard-coded stub returning `{ night: '0', dust: '0' }` (line 33 of balance.ts hard-codes night to '0'; balance.ts:29 forgets to pass `dustAddress` so DUST also short-circuits) | Delete both files. Real balances are available via the TUI or after `wallet use` + sync. | done |
| 8c | `transaction/builder.ts` + `cli/commands/mint.ts` — `TransactionBuilder` is an envelope-only stub; `moth mint` unconditionally throws "Not yet implemented" at line 47 before submission | Keep both files; add TODO comments at top of each explaining the gap and pointing to `sync/operations.ts` as the reference flow. Future work: migrate `moth mint` to the facade `transferTransaction` pattern. | docs only |
| 9 | `browser/src/adapters/passphrase.ts` — dead `deriveKeyFromPassphrase` (PBKDF2 + AES-GCM) helper; cryptographically weaker than core's keystore (scrypt N=2^18 + ChaCha20-Poly1305) and never wired in. `createMothBrowser` already uses core's keystore (works in browser via pure-JS `@noble/*`) | Delete file + barrel re-export. The core keystore is the shared implementation. | done |
| 24 | `DerivedKeys` type in `types/wallet.ts` — structurally equivalent to SDK's `Record<Role, Uint8Array>` but with named fields | Keep — named fields (`wallet.keys.zswap`) are more ergonomic than `wallet.keys[Roles.Zswap]` for downstream consumers. App-level view type, not real duplication. | kept |
| 27 | `SubmissionEvent` type union in `types/transaction.ts` — 7 cases mirroring polkadot TxStatus; the SDK's is 3 cases with different shape (`_tag` vs `tag`) | Delete after #6 — no production callers remain once `JsonRpcNodeClient.submitTransaction` is gone. SDK's `SubmissionEvent` from `wallet-sdk-node-client` is available if needed in the future. | done |

## SDK gaps (intentionally kept in `@moth/core`)

These are not duplications — the SDK doesn't provide an equivalent, so the local
implementations stay.

| File | What it does | Why no SDK equivalent |
|---|---|---|
| `core/src/wallet/keystore.ts` | scrypt N=2^18 + ChaCha20-Poly1305 mnemonic vault. Versioned format with v1→v2 KDF upgrade path. | SDK has no passphrase-wrapping keystore primitive. `createKeystore` in `wallet-sdk-unshielded-wallet` is unrelated (signs txs). Candidate for upstream `@midnight-ntwrk/wallet-sdk-keystore` package. |
| `core/src/wallet/mnemonic.ts` (`mnemonicToSeed` only) | BIP39 `mnemonic → seed` via `@scure/bip39`'s `mnemonicToSeedSync`. | SDK uses raw seeds end-to-end via `HDWallet.fromSeed(seed)`; no public mnemonic→seed bridge. Candidate for upstream addition to `wallet-sdk-hd`. |
| `core/src/network/indexer-client.ts` | Direct GraphQL queries the SDK provider doesn't expose: dust-generation status, raw block/peer info, contract action history. Consumed by `tui/hooks/useDust.ts`, `cli/commands/dust/status.ts`, `tui/screens/contract.tsx`, `contract/state.ts`. | `indexerPublicDataProvider` from `midnight-js-indexer-public-data-provider` is shaped for `submitCallTx` / `WalletFacade`'s consumption (protocol-level queries), not application-level GraphQL. |
| `core/src/network/node-client.ts` (read-only methods only after #6) | Chain status RPCs (`getBlockHeight`, `getGenesisHash`, `getContractState`, `getLedgerVersion`). Consumed by `cli/commands/info.ts`, `tui/hooks/useNetwork.ts`. | `WalletFacade` doesn't expose chain-status reads. `wallet-sdk-node-client`'s `PolkadotNodeClient` may cover some of these via its underlying ApiPromise but isn't a direct drop-in for our read-only shape. |
| `core/src/proof/client.ts` | Proof-server `/ready` health probe (`healthCheck`, `ensureReady`) and direct `/prove`/`/check` payload submission for `call.ts`'s proof provider. | `httpClientProofProvider` from `midnight-js-http-client-proof-provider` has no health endpoint. |

## Upstream feature requests (suggested)

1. **`@midnight-ntwrk/wallet-sdk-keystore`** — passphrase-wrapping mnemonic
   vault primitive (scrypt/argon2 + AEAD). Currently `moth-wallet` is the only
   layer providing this.
2. **`HDWallet.fromMnemonic(mnemonic): seed`** — a public mnemonic→seed bridge
   on `@midnight-ntwrk/wallet-sdk-hd`, so consumers don't need a direct
   `@scure/bip39` dep just for `mnemonicToSeedSync`.
3. **Proof-server health endpoint on `httpClientProofProvider`** — so consumers
   don't need a parallel `ProofClient` for `/ready` checks.
4. **Chain-status read API on `WalletFacade`** — block height, peers, sync gap,
   ledger version. Would let `cli/info` and `tui/useNetwork` drop the local
   `JsonRpcNodeClient` shell.

## Architectural notes (post-cleanup)

### What changed in the contract-call submission path
Before #6, `call.ts` used `midnight-provider.ts` → `JsonRpcNodeClient.submitTransaction` → hand-rolled `encodeMidnightExtrinsic` → JSON-RPC `author_submitExtrinsic`. After #6, `midnight-provider.ts` uses `PolkadotNodeClient.sendMidnightTransactionAndWait(serialized, 'Submitted')` from `@midnight-ntwrk/wallet-sdk-node-client`. `JsonRpcNodeClient` retains only its read-only chain-status methods (`getBlockHeight` etc.).

### The two contract-submission patterns
- `deploy.ts` constructs a `WalletFacade` and routes `midnightProvider.submitTx` through `facade.submitTransaction`. Wallet-balanced.
- `call.ts` does not construct a facade — it builds its own minimal providers (`walletProvider` with identity `balanceTx`, local `proofProvider`) and uses `PolkadotNodeClient` directly via `midnight-provider.ts`.

These could be unified by refactoring `call.ts` to take a synced wallet (with facade in scope), but that's a larger CLI-side change and was deferred. See open issue (TBD).

### Dependency hygiene
- `core/package.json` removed: `@scure/bip32`.
- `core/package.json` added: `@midnight-ntwrk/wallet-sdk-node-client@1.1.1`.
- `core/package.json` kept (still needed): `@noble/ciphers`, `@noble/hashes` (keystore.ts), `@scure/bip39` (mnemonic.ts `mnemonicToSeed`).
- `@midnight-ntwrk/wallet-sdk-facade` is already a direct dep (`core/package.json:30`).

## Verification

These changes were not yet typechecked or built — dependencies aren't installed
in the working tree. Before merging:

```bash
yarn install
yarn build
yarn test
```

Then exercise:
- `moth wallet generate` (mnemonic gen via SDK)
- `moth wallet import` (mnemonic→seed via local wrapper)
- `moth transfer` (facade.transferTransaction)
- `moth deploy` (already SDK-aligned, regression check)
- `moth call` (new `NodeZkConfigProvider` + new `PolkadotNodeClient` submit path)
- TUI dashboard (sync via facade observable)

Known still-broken: `moth mint`, `moth balance` (deleted).
