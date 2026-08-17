# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Wallet daemon (`moth daemon ...`)

Long-running wallet host that owns the spending keys and exposes an RPC surface over a Unix socket. CLI commands (and a future Web2 service) route through it instead of each opening their own indexer subscription, eliminating the concurrent-sync race that previously corrupted on-disk caches. Spending keys never leave the daemon process.

- `moth daemon serve` — headless mode for integration tests and the eventual service deployment. Requires both `--auto-approve` and `MOTH_DAEMON_AUTO_APPROVE=1` (two-flag arming so a stray flag in shell history can't disable consent). Auto-approves every L3 confirmation modal and logs each grant to stderr for audit.
- `moth wallet status` — read the daemon's view of sync progress + balances without spinning up a parallel sync. Errors clearly when no daemon is hosting the requested wallet.
- `moth daemon submit-tx` — submit a pre-built finalized transaction. Reads hex from `--hex` or stdin; prefers stdin so transaction bytes don't end up in `ps`.
- `moth daemon transfer` — transfer NIGHT or any custom token. `--amount <raw>` accepts smallest-unit decimals; `--night <decimal>` is a shortcut that multiplies by 10^6 STARS and is rejected for non-NIGHT token IDs. Fully validates client-side before reaching the daemon.
- `moth daemon call` — call a circuit on a deployed contract. Same flag shape as `moth call` (`--address`, `--artifact`, `--witnesses`, `--args`, `--project-dir`). Eager artifact load + circuit-name validation in the daemon before the L3 modal.
- `moth daemon deploy` — deploy a compiled contract. Positional or `--artifact`; supports `--witnesses` and `--project-dir`. Default 600s timeout for proof generation.
- `moth daemon dust register` / `moth daemon dust deregister` — flip NIGHT UTXOs in/out of dust-generation mode. Register returns `{registered: false, txId: null}` when there's nothing to register.
- `moth daemon maintenance insert-vk` and `moth daemon maintenance insert-vks-batch` — daemon-routed verifier-key inserts for staged contract deployment. Same flags as the standalone `moth maintenance` commands; default 30-minute timeout for large batches.

L1 (kernel-enforced UID-only socket perms) + L3 (per-operation human confirmation in the TUI modal) form the daemon's local-host security model. Service-mode AuthN/AuthZ is spec'd in `docs/spec/wallet-service/` and not yet implemented.

#### Core API additions

- `startDaemon({socketPath, handlers, daemonVersion})` — bind a Unix socket at `~/.moth/sync/<network>/<wallet>.sock` (mode 0600 in 0700 directory), reap stale sockets from crashed previous instances, dispatch RPC requests to a typed handler map.
- `connectDaemon(socketPath)` — connect, perform the version handshake, return a `DaemonClient` or null when no daemon is reachable.
- `buildWalletHandlers(deps)` — shared factory that returns the complete RPC handler map. Used by both the TUI host and `moth daemon serve`.
- `ConfirmationQueue` — framework-free FIFO for L3 approval requests. The TUI subscribes via a React component; headless mode wraps it in auto-approve.
- `sendTokensWithKeys`, `designateForDustWithKeys`, `dedesignateFromDustWithKeys`, plus `walletKeys` on `CallOptions` / `DeployOptions` / `InsertVerifierKeyOptions` / `InsertVerifierKeysOptions` — every write path accepts a pre-derived `WalletKeys` bundle so the BIP-39 seed never needs to be passed through.
- `deriveWalletKeys(seedHex)` — extract the typed key bundle from a seed.
- Parser exports for every daemon verb's wire format (`parseTransferTokensParams`, `parseCallCircuitParams`, ...) — usable by external clients and tests.

#### Sync engine

- Off-thread catch-up sync (P3-B) — opt-in via `MOTH_SYNC_WORKER=1`. Long historical replays run in a `worker_threads` worker so the TUI / CLI event loop stays responsive. The worker serializes wallet state back to the main thread for steady-state takeover.
- `SYNC_BATCH_UPDATES` constant — `{size: 1000, timeout: 1000, spacing: 0}` for the shielded sub-wallet, materially faster than the SDK defaults for resync wall-clock. Dust kept at the SDK default because of a known upstream off-by-one in `wallet-sdk-dust-wallet` at large batch sizes.
- Client-side dedup wrapper around `wallet-sdk-shielded` and `wallet-sdk-dust-wallet` (`sync/sdk-dedup.ts`) — filters re-sent boundary events the SDKs' `applyUpdate` lets through, fixing intermittent "values inserted non-linearly into [zswap|dust] commitment tree" errors. Upstream issue draft in `docs/upstream/wallet-sdk-sync-applyUpdate-off-by-one.md`.

#### Wallet management

- `moth wallet generate --birthday <block-height>` — for fresh wallets that have never been funded, persists the birthday block height to wallet metadata. Future sync paths can use this to skip historical scanning. Only safe for wallets that genuinely have zero pre-existing UTXOs.

#### Living spec

- `docs/spec/wallet-service/` — long-running design conversation for evolving the wallet into a network-accessible service. README + CHANGELOG + nine sections (architecture, authentication, authz/policy, approval pipeline, key management, audit, failure modes, multi-tenant roadmap, threat model). PRs touching service-path behavior update the relevant section.
- `05-key-management.md` accepted with five numbered decisions and a staged-implementation table. D-KM-3 (derive-and-drop) shipped.
- `01-architecture.md` draft: process model per stage, transport per stage, deployment shapes, dependencies, verb surface, four architecture decisions (single protocol across transports, one daemon per wallet, config precedence, reverse-proxy TLS).

#### Tests

- Daemon integration test harness at `packages/cli/tests/integration/daemon/`. Each test file spawns a fresh `moth daemon serve --auto-approve` against an airdropped test wallet, exercises one verb, asserts on real on-chain results. Twelve tests across five files (`daemon-transfer`, `daemon-call`, `daemon-submit-tx`, `daemon-deploy`, `daemon-dust-register`, `daemon-maintenance`). Skip cleanly without `MOTH_DEVNET_URL`, matching the existing CI-pipeline gate.
- 36 new unit tests for daemon param parsers, the confirmation queue, daemon protocol framing, and the sync dedup wrapper.

#### Earlier in this release

- `moth maintenance insert-vks-batch` — Level 1 batching for verifier-key inserts. One command iterates a list of circuits (default: every `.verifier` in the artifact's `keys/` dir; `--circuits a,b,c` for a subset) and submits one maintenance tx per circuit, sharing a single wallet sync across the whole batch. `--skip-existing` queries the chain first and omits already-defined circuits, making the command idempotent and resume-friendly. Wall time for a 20-circuit deploy drops from ~70-90 min (one-shot `insert-vk` loop) to ~20-30 min. Each insert is still its own transaction because the maintenance authority counter is monotonic; Level 2 (multiple `SingleUpdate` entries in one tx) is left for later.
- `insertVerifierKeys(opts)` core API alongside `insertVerifierKey(opts)` — takes an array of `{circuitId, verifierKeyPath}`, returns a `BatchInsertResult` with per-entry status, and exposes an `onProgress` callback for streaming updates back to the CLI.
- `moth maintenance insert-vk` — insert a verifier key for a circuit on an already-deployed contract via a Midnight maintenance update. Signed by the contract's maintenance authority; signing key is read from moth's private state (the same store `moth deploy` writes to). Enables staged deployment of contracts whose verifier-key payload exceeds the per-tx block weight cap: deploy a stub with `export` stripped from non-essential circuits, then loop `insert-vk` for each remaining circuit.
- New `insertVerifierKey()` core API in `@shieldedtech/moth-wallet` mirroring the `callCircuit` provider setup, calling `submitInsertVerifierKeyTx` from midnight-js. See README "Maintenance Updates" for the operator workflow.

### Changed

#### Breaking: `UnlockedWallet` shape (D-KM-3 follow-up)

- `UnlockedWallet.seedHex` getter **removed**. The BIP-39 seed is now derived into the typed `WalletKeys` bundle inside `WalletManager.unlock()` and the raw string is dropped before the unlocked wallet object returns. External consumers reading `wallet.seedHex` must migrate to `wallet.walletKeys`. The threat-model justification is in `docs/spec/wallet-service/05-key-management.md` D-KM-3.
- `UnlockedWallet.clearSeed()` **removed** — there's no in-memory seed to clear after unlock returns.
- `startWalletSync(walletKeys, ...)` — was `startWalletSync(seedHex, ...)`. Same for `preSeedNewWallet`, `executeBatchTransfer`. The old seed-based variants are gone; callers pass `wallet.walletKeys` directly.
- `WalletKeys` interface moved from `sync/operations.ts` to `types/wallet.ts` so `UnlockedWallet` can reference it without a cross-module import. Still exported from both locations.

#### Daemon refactor

- Shared `buildWalletHandlers(deps)` factory in core. Previously every daemon verb had two copies of its handler body — one in `packages/tui/src/hooks/useDaemonHost.ts`, one in `packages/cli/src/commands/daemon/serve.ts`. Each new verb meant editing both files. Now both hosts call the factory with a small dependency bundle. ~2145 LoC of duplicated handler code collapsed to ~906 LoC across the shared factory plus two thin host files (TUI hook went from 1226 → 140 LoC; serve.ts went from 919 → 185 LoC).
- Wallet-RPC parsers (`parseTransferTokensParams`, `parseCallCircuitParams`, etc.) and the `shortenHex` / `shortenAddress` formatters moved to public exports of `@shieldedtech/moth-wallet`. External clients and tests can validate wire payloads without importing TUI internals.

#### Sync robustness

- Shielded wallet now uses a deduping `syncCapability` (`packages/core/src/sync/sdk-dedup.ts`) that filters re-sent boundary events from the indexer before they reach `replayEventsWithChanges`, working around a known upstream off-by-one in `@midnight-ntwrk/wallet-sdk-shielded`. Same wrapper applied to the dust sub-wallet. Eliminates intermittent "values inserted non-linearly into commitment tree" sync failures.

#### Earlier in this release

- TUI overhaul: stack-based navigation with a multi-screen onboarding wizard (name, network select, seed source, seed entry / mnemonic display, passphrase, unlock, initializing, wallet select), a split dashboard (`DashboardHub` + `StateView`), and shared `BackHint`/`HelpFooter`/`Loader`/`SectionHeader`/`Select` components. Replaces the previous flat dashboard + `NavMenu`/`DustMonitor`.
- Consolidated HD derivation on `@midnight-ntwrk/wallet-sdk-hd` (`HDWallet.fromSeed`); removed the parallel `@scure/bip32` path in `core/src/wallet/hd.ts`.
- `core/src/wallet/mnemonic.ts` `generateMnemonic24`/`validateMnemonic` now delegate to `wallet-sdk-hd`; `sync/preseed.ts` no longer imports `@scure/bip39` directly.
- Contract-call tx submission now goes through `@midnight-ntwrk/wallet-sdk-node-client`'s `PolkadotNodeClient`; the hand-rolled SCALE codec is removed.
- `contract/call.ts` now uses the SDK's `NodeZkConfigProvider` (same as `deploy.ts`), fixing a latent path-resolution bug where the local provider expected an extra `managed/` directory level.
- `cli/src/base-command.ts` imports `FilesystemStorageAdapter` from `@shieldedtech/moth-wallet` instead of redefining it locally.

### Removed

- `UnlockedWallet.seedHex` getter and `UnlockedWallet.clearSeed()` method (per the breaking change above). External consumers must migrate to `wallet.walletKeys`.
- `useWallet().getActiveSeedHex()` in the TUI (replaced by `getActiveWalletKeys()`).

#### Earlier in this release

- `core/src/wallet/hd.ts` (duplicate of SDK `HDWallet`).
- `core/src/network/scale.ts` (replaced by `wallet-sdk-node-client`).
- `core/src/sync/engine.ts` (`SyncEngine` — orphan; real sync goes through `WalletFacade.state()`).
- `core/src/wallet/balance.ts` + `cli/src/commands/balance.ts` (`moth balance` was a hard-coded stub returning `{night: '0', dust: '0'}`).
- `core/src/providers/{public-data-provider,proof-provider,zk-config-provider}.ts` (dead adapters; deploy + call already use SDK providers).
- `cli/src/adapters/fs-storage.ts` (duplicate of core's `FilesystemStorageAdapter`).
- `browser/src/adapters/passphrase.ts` (dead PBKDF2/AES-GCM helper; cryptographically weaker than core's keystore and never wired in).
- `SubmissionEvent`/`SubmissionEventTag` types from `core/src/types/transaction.ts` (no callers post-SCALE-removal).
- `JsonRpcNodeClient.submitTransaction` (replaced by `PolkadotNodeClient`); class is now read-only chain-status.
- Public exports removed from `core/src/index.ts`: `deriveKeys`, `clearKeys`, `PURPOSE`, `COIN_TYPE`, `SyncEngine`, `queryBalance`, `WalletBalance`, `encodeMidnightExtrinsic`, `encodeCompact`, `scaleToHex`, `createProofProvider`, `createPublicDataProvider`, `createZKConfigProvider`, `SubmissionEvent`. From `browser/src/index.ts`: `SyncEngine`, `SubmissionEvent`, `deriveKeyFromPassphrase`.
- TUI: `dashboard.tsx` (split into `dashboard/DashboardHub.tsx` + `dashboard/StateView.tsx`), `components/{NavMenu,DustMonitor}.tsx`, `hooks/useDust.ts`.

### Dependencies

- Removed `@scure/bip32` from `core/package.json` (now transitive via `wallet-sdk-hd`).
- Added `@midnight-ntwrk/wallet-sdk-node-client@1.1.1` to `core/package.json`.

### Deprecated

- `core/src/transaction/builder.ts` and `cli/src/commands/mint.ts` — known stubs (mint throws "Not yet implemented"). Annotated with TODO comments pointing to the facade flow as the migration target.

See `specs/002-sdk-duplication-audit/audit.md` for the full audit, per-finding rationale, and notes on SDK gaps that `@shieldedtech/moth-wallet` still fills.
