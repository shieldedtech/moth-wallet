> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Tasks: Isomorphic Wallet Tool

**Input**: Design documents from `specs/001-isomorphic-wallet-tool/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required for security-critical code per Constitution Principle IV
(Test-First Development). Key management, cryptographic operations, and
transaction building MUST have failing tests before implementation.

**Organization**: Tasks grouped by user story. Each story is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1, US2, US3, US4, US5, US6)
- Paths use monorepo layout: `packages/{core,cli,browser,tui}/src/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo scaffolding, build tooling, shared configuration

- [x] T001 Initialize Yarn 4 workspace with `package.json` at repository root with `workspaces` field listing `packages/*`
- [x] T002 Create `turbo.json` with build pipeline: core → cli, core → browser, core → tui
- [x] T003 [P] Create `tsconfig.base.json` with strict TypeScript 5.5+ config (ESM, NodeNext module resolution, strict: true)
- [x] T004 [P] Create `vitest.workspace.ts` referencing all four packages
- [x] T005 [P] Create `packages/core/package.json` with name `@moth/core`, ESM exports, zero platform-specific dependencies
- [x] T006 [P] Create `packages/cli/package.json` with name `@moth/cli`, bin entry `midnight`, dependencies on `@moth/core` and `oclif`
- [x] T007 [P] Create `packages/browser/package.json` with name `@moth/browser`, ESM-only exports, dependency on `@moth/core`
- [x] T008 [P] Create `packages/tui/package.json` with name `@moth/tui`, dependencies on `@moth/core`, `ink`, `react`
- [x] T009 [P] Create `packages/core/tsconfig.json` extending base config
- [x] T010 [P] Create `packages/cli/tsconfig.json` extending base config
- [x] T011 [P] Create `packages/browser/tsconfig.json` extending base config
- [x] T012 [P] Create `packages/tui/tsconfig.json` extending base config
- [x] T013 Install dependencies: `@scure/bip39`, `@scure/bip32`, `@noble/ciphers`, `@polkadot/api`, `graphql-request`, `oclif`, `ink`, `react`
- [x] T014 Verify `yarn build` succeeds across all packages with empty entry points

**Checkpoint**: Monorepo builds. All packages resolve each other. CI can run `yarn build && yarn test`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, interfaces, and clients that ALL user stories depend on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T015 Define shared type definitions in `packages/core/src/types/index.ts`: NetworkConfig, WalletInfo, UnlockedWallet, DerivedKeys, SyncState, SubmissionEvent, TransactionResult, ExitCodes enum
- [x] T016 [P] Define StorageAdapter interface in `packages/core/src/storage/adapter.ts` with read/write/delete/list/exists methods (per core-api.md contract)
- [x] T017 [P] Define error types in `packages/core/src/types/errors.ts`: NetworkError, WalletError, ProofError, TimeoutError, InvalidInputError (per FR-020)
- [x] T018 [P] Define exit code constants in `packages/core/src/types/exit-codes.ts`: SUCCESS=0, FAILURE=1, PARTIAL=2, TIMEOUT=3 (per FR-018, FR-033)
- [x] T019 Write tests for HD key derivation in `packages/core/tests/unit/wallet/hd-derivation.test.ts`: BIP-44 path `m/44'/2400'/{account}'/{role}/{index}`, all 5 roles (NightExternal=0..Metadata=4), edge cases (zero index, max index, invalid seed)
- [x] T020 Implement HD key derivation in `packages/core/src/wallet/hd.ts` using `@scure/bip32` with PURPOSE=44, COIN_TYPE=2400, 5 roles matching wallet SDK constants. Include `clear()` to wipe private data (Constitution III)
- [x] T021 Write tests for keystore encryption in `packages/core/tests/unit/wallet/keystore.test.ts`: encrypt/decrypt round-trip, wrong passphrase rejection, corruption detection, field boundary values
- [x] T022 Implement EncryptedKeystore in `packages/core/src/wallet/keystore.ts` using `@noble/ciphers` ChaCha20-Poly1305: encrypt(mnemonic, passphrase) → {version, algorithm, salt, nonce, ciphertext, tag}, decrypt(keystore, passphrase) → mnemonic (Constitution III: authenticated encryption)
- [x] T023 Write tests for mnemonic handling in `packages/core/tests/unit/wallet/mnemonic.test.ts`: generate 24-word, validate valid/invalid, import from hex seed
- [x] T024 Implement mnemonic utilities in `packages/core/src/wallet/mnemonic.ts` using `@scure/bip39`: generate(), validate(), toSeed(), fromHexSeed()
- [x] T025 [P] Implement WalletManager in `packages/core/src/wallet/manager.ts`: generate, import, importFromSeed, unlock, lock, remove, list, getActive, setActive (per core-api.md). Depends on StorageAdapter, keystore, mnemonic, HD modules
- [x] T026 [P] Implement NetworkClient in `packages/core/src/network/node-client.ts`: connect (WsProvider), disconnect, submitTransaction (api.tx.midnight.sendMnTransaction), getBlockHeight, getGenesisHash, isConnected. Uses `@polkadot/api`
- [x] T027 [P] Implement IndexerClient in `packages/core/src/network/indexer-client.ts`: HTTP queries (block, transactions, contractAction, dustGenerationStatus) + WS subscriptions (blocks, contractActions, shieldedTransactions, unshieldedTransactions). Uses `graphql-request` + `graphql-ws`
- [x] T028 [P] Implement ProofClient in `packages/core/src/proof/client.ts`: healthCheck (GET /health, /ready), prove (POST /prove with binary payload), check (POST /check). Includes pre-flight health check logic (FR-032), 5-minute timeout, 3 retries on 502/503/504
- [x] T029 [P] Implement SyncEngine in `packages/core/src/sync/engine.ts`: background sync via indexer subscriptions, cache state between runs, waitForTip with configurable timeout, progress callbacks (per FR-031)
- [x] T030 Implement filesystem StorageAdapter in `packages/cli/src/adapters/fs-storage.ts`: read/write encrypted JSON files under `~/.moth/`, file permissions 0600 (FR-005), file locking for concurrent access
- [x] T031 [P] Implement CLI output formatters in `packages/cli/src/formatters/index.ts`: text (human-readable tables) and json (structured) formatters, error formatter with category + message (FR-017, FR-019, FR-020)
- [x] T032 [P] Implement passphrase prompting in `packages/cli/src/adapters/passphrase.ts`: interactive terminal prompt when TTY available, `MOTH_PASSPHRASE` env var fallback for CI (FR-006). MUST NOT accept passphrase as CLI argument (SR-001)
- [x] T033 Implement oclif BaseCommand in `packages/cli/src/commands/base.ts`: shared flags (--output, --network, --wallet, --verbose, --timeout, --proof-server), wallet/network resolution, error handling with exit codes

**Checkpoint**: Core library compiles. Key derivation, encryption, and mnemonic tests pass. Network clients can connect to devnet. CLI base command handles flags.

---

## Phase 3: User Story 1 - Deploy a Compiled Contract (Priority: P1)

**Goal**: `moth deploy <artifact-path>` deploys a contract and returns the address.

**Independent Test**: Deploy a pre-compiled counter contract to devnet, verify the returned address is queryable via `moth state`.

### Tests for User Story 1

- [x] T034 [P] [US1] Write integration test for deploy flow in `packages/core/tests/integration/deploy.test.ts`: load artifact, build deploy transaction, prove, submit, receive contract address
- [x] T035 [P] [US1] Write unit test for contract artifact loader in `packages/core/tests/unit/contract/artifact-loader.test.ts`: load valid artifact directory, reject invalid/missing artifacts, extract circuit names and initial state

### Implementation for User Story 1

- [x] T036 [P] [US1] Implement ContractArtifactLoader in `packages/core/src/contract/artifact-loader.ts`: load `compact compile` managed/ output directory, parse circuit definitions, extract initial state, validate artifact integrity
- [x] T037 [US1] Implement TransactionBuilder.buildDeploy() in `packages/core/src/transaction/builder.ts`: construct deploy transaction from artifact + wallet keys + optional witnesses, serialize for proof server
- [x] T038 [US1] Implement deploy orchestration in `packages/core/src/contract/deploy.ts`: pre-flight proof server check → load artifact → build tx → prove → submit → wait for finalization → extract contract address. Configurable timeout (default 60s per FR-020b)
- [x] T039 [US1] Implement `moth deploy` CLI command in `packages/cli/src/commands/deploy.ts`: parse artifact path, optional --witnesses flag, --name label, --timeout override. Output: contractAddress, txHash, fees. Exit codes per contract
- [x] T040 [US1] Implement witness provider loader in `packages/core/src/contract/witness-loader.ts`: dynamic import of JS witness file, validate it exports `makeWitnesses` function

**Checkpoint**: `moth deploy ./managed/counter --project-dir . --output json` works against devnet. Returns contract address.

---

## Phase 4: User Story 2 - AI Agent Deploys and Tests (Priority: P1)

**Goal**: `moth call <circuit> --address <addr>` and `moth state <addr>` for agent workflows.

**Independent Test**: Deploy counter, call increment, query state, verify counter=1. All JSON output.

### Implementation for User Story 2

- [x] T041 [P] [US2] Implement TransactionBuilder.buildCircuitCall() in `packages/core/src/transaction/builder.ts`: construct circuit call transaction from circuit name + contract address + args + wallet keys
- [x] T042 [P] [US2] Implement argument parser in `packages/core/src/contract/args-parser.ts`: parse inline JSON string or load from `@file.json` path (FR: `--args` auto-detect, values starting with `@` are file paths)
- [x] T043 [US2] Implement circuit call orchestration in `packages/core/src/contract/call.ts`: pre-flight check → parse args → build tx → prove → submit → wait → extract result. Configurable timeout (default 30s)
- [x] T044 [US2] Implement contract state query in `packages/core/src/contract/state.ts`: query indexer `contractAction` by address, decode public ledger state, return structured data
- [x] T045 [US2] Implement `moth call` CLI command in `packages/cli/src/commands/call.ts`: circuit name positional arg, --address, --args (inline or @file), --timeout. Output: txHash, status, result, fees
- [x] T046 [US2] Implement `moth state` CLI command in `packages/cli/src/commands/state.ts`: contract address positional arg. Output: address, decoded state, lastUpdated block info
- [X] T047 [US2] Write end-to-end test in `packages/cli/tests/integration/agent-workflow.test.ts`: deploy counter → call increment → query state → assert counter=1 (all JSON output, parsed between steps)

**Checkpoint**: Agent workflow works: deploy → call → state → verify. SC-002 target: ≤5 commands, ≥90% success.

---

## Phase 5: User Story 3 - Manage Wallet from Terminal (Priority: P2)

**Goal**: `moth balance`, `moth transfer`, `moth dust register/status` as non-interactive commands.

**Independent Test**: Check balance, transfer NIGHT, verify DUST status — each independently with correct exit codes.

### Implementation for User Story 3

- [x] T048 [P] [US3] Implement TransactionBuilder.buildTransfer() in `packages/core/src/transaction/builder.ts`: construct NIGHT transfer (shielded + unshielded) from amount + recipient + wallet keys
- [x] T049 [P] [US3] Implement TransactionBuilder.buildDustRegister() and buildDustDeregister() in `packages/core/src/transaction/builder.ts`
- [x] T050 [P] [US3] Implement balance query in `packages/core/src/wallet/balance.ts`: query indexer for unshielded UTXOs by address, aggregate NIGHT balance; query DUST generation status for DUST balance
- [x] T051 [US3] Implement transfer orchestration in `packages/core/src/wallet/transfer.ts`: validate amount → build tx → prove → submit → wait. Timeout default 30s
- [X] T052 [US3] Implement batch transfer in `packages/core/src/wallet/batch-transfer.ts`: load transfer list from JSON file/stdin, execute sequentially, collect per-item results, return exit code 0/1/2 (FR-033)
- [x] T053 [US3] Implement `moth balance` CLI command in `packages/cli/src/commands/balance.ts`: display NIGHT (in STAR) and DUST (in SPECK) balances. Text table default, JSON with --output json
- [x] T054 [US3] Implement `moth transfer` CLI command in `packages/cli/src/commands/transfer.ts`: amount + NIGHT positional args, --to, --shielded flag. Requires confirmation unless --yes
- [X] T055 [US3] Implement `moth transfer batch` CLI subcommand in `packages/cli/src/commands/transfer/batch.ts`: file path or @stdin, per-item reporting, three-tier exit codes
- [x] T056 [US3] Implement `moth dust register` CLI command in `packages/cli/src/commands/dust/register.ts`
- [x] T057 [US3] Implement `moth dust deregister` CLI command in `packages/cli/src/commands/dust/deregister.ts`
- [x] T058 [US3] Implement `moth dust status` CLI command in `packages/cli/src/commands/dust/status.ts`: registered, dustAddress, nightBalance, generationRate, maxCapacity, currentCapacity

**Checkpoint**: All wallet management commands work independently. balance/transfer/dust cycle complete.

---

## Phase 6: User Story 4 - CI Pipeline Integration (Priority: P2)

**Goal**: Ephemeral wallet lifecycle for CI: generate → fund → deploy → call → assert → discard.

**Independent Test**: Run full CI script: generate wallet, airdrop, deploy, call, assert, remove. All zero-config on devnet.

### Implementation for User Story 4

- [x] T059 [P] [US4] Implement `moth wallet generate` CLI command in `packages/cli/src/commands/wallet/generate.ts`: --name flag (auto-generate if omitted), passphrase from env or prompt, JSON output with name + address (FR-028)
- [x] T060 [P] [US4] Implement `moth wallet import` CLI command in `packages/cli/src/commands/wallet/import.ts`: mnemonic from stdin pipe or interactive prompt (not env var — SR-001), --seed-hex option
- [x] T061 [P] [US4] Implement `moth wallet list` CLI command in `packages/cli/src/commands/wallet/list.ts`: table of wallet name, address, active status, network
- [x] T062 [P] [US4] Implement `moth wallet use` CLI command in `packages/cli/src/commands/wallet/use.ts`: switch active wallet
- [x] T063 [P] [US4] Implement `moth wallet remove` CLI command in `packages/cli/src/commands/wallet/remove.ts`: confirmation prompt or --yes, delete keystore + sync files
- [x] T064 [US4] Implement `moth airdrop` CLI command in `packages/cli/src/commands/airdrop.ts`: request test tokens on devnet, fail with clear error on non-dev networks (FR-029)
- [x] T065 [US4] Implement `moth info` CLI command in `packages/cli/src/commands/info.ts`: network, nodeUrl, indexerUrl, proofServerUrl, blockHeight, syncStatus
- [X] T066 [US4] Write CI integration test in `packages/cli/tests/integration/ci-pipeline.test.ts`: full generate → airdrop → deploy → call → state → remove cycle with JSON output and exit code assertions

**Checkpoint**: CI pipeline script runs end-to-end on devnet. SC-003 target: <1 hour to integrate.

---

## Phase 7: User Story 5 - Browser-Based Wallet Operations (Priority: P3)

**Goal**: `@moth/browser` library runs in modern browsers with IndexedDB storage.

**Independent Test**: Load library in browser, init wallet, query balance and contract state against devnet, verify results match CLI.

### Implementation for User Story 5

- [x] T067 [P] [US5] Implement IndexedDB StorageAdapter in `packages/browser/src/adapters/idb-storage.ts`: read/write/delete/list/exists using IndexedDB stores (midnight-wallet-config, midnight-wallet-keystores, midnight-wallet-sync)
- [x] T068 [P] [US5] Implement Web Crypto passphrase handling in `packages/browser/src/adapters/passphrase.ts`: derive encryption key from passphrase using PBKDF2 via Web Crypto API
- [x] T069 [US5] Implement browser entry point in `packages/browser/src/index.ts`: export createWalletCore factory with IndexedDB adapter pre-configured, re-export core types
- [x] T070 [US5] Configure browser build in `packages/browser/package.json`: ESM-only exports, no Node.js-specific imports, tree-shakeable
- [X] T071 [US5] Write browser integration test in `packages/browser/tests/integration/browser.test.ts` using Playwright: load library in browser page, init wallet from mnemonic, query balance, query contract state, verify results

**Checkpoint**: Browser library loads in Chrome/Firefox/Safari. Balance queries and state inspection work.

---

## Phase 8: User Story 6 - Interactive Terminal Dashboard (Priority: P3)

**Goal**: `moth tui` launches live dashboard with wallet state, network status, and interactive operations.

**Independent Test**: Launch TUI, verify it shows balance, sync status, and can execute a transfer.

### Implementation for User Story 6

- [x] T072 [P] [US6] Implement TUI app shell in `packages/tui/src/app.tsx`: Ink app root with screen router, header (wallet name, network, sync status), navigation
- [x] T073 [P] [US6] Implement Dashboard screen in `packages/tui/src/screens/dashboard.tsx`: NIGHT balance, DUST balance, recent transactions, network block height, sync percentage (real-time updates via core SyncEngine)
- [x] T074 [P] [US6] Implement Transfer screen in `packages/tui/src/screens/transfer.tsx`: amount input, recipient input, shielded toggle, confirmation step, transaction status display
- [x] T075 [P] [US6] Implement DUST screen in `packages/tui/src/screens/dust.tsx`: registration status, register/deregister actions, accrual monitoring
- [x] T076 [P] [US6] Implement Deploy screen in `packages/tui/src/screens/deploy.tsx`: artifact path input, witness file input, deployment progress, contract address display
- [x] T077 [P] [US6] Implement Contract State screen in `packages/tui/src/screens/state.tsx`: contract address input, decoded state display, auto-refresh via subscription
- [x] T078 [US6] Implement `moth tui` CLI command in `packages/cli/src/commands/tui.ts`: launch Ink app, configure as default when no subcommand provided
- [x] T079 [US6] Implement React hooks wrapping core operations in `packages/tui/src/hooks/`: useWallet, useBalance, useSync, useTransfer, useDeploy, useDustStatus

**Checkpoint**: TUI launches, shows live data, and can execute transfers interactively.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Security hardening, documentation, final quality checks

- [x] T080 [P] Implement `moth mint` CLI command in `packages/cli/src/commands/mint.ts`: amount, --address, --token-type. Uses TransactionBuilder.buildMint()
- [x] T081 [P] Implement TransactionBuilder.buildMint() in `packages/core/src/transaction/builder.ts`
- [x] T082 [P] Add --verbose debug logging to all CLI commands in `packages/cli/src/commands/base.ts`: timestamped structured log lines to stderr, filter sensitive data (Constitution I, SR-005)
- [x] T083 [P] Add network configuration persistence in `packages/cli/src/commands/config.ts`: `moth config set <key> <value>`, `moth config get <key>`
- [x] T084 Security audit: verify no passphrase/mnemonic/key appears in --verbose output, error messages, or JSON output across all commands (SC-010, Constitution III, SR-001)
- [x] T085 [P] Add connection timeout handling to all network clients in `packages/core/src/network/`: 10-second timeout with clear error (edge case from spec)
- [x] T086 [P] Add devnet genesis reset detection in `packages/core/src/sync/engine.ts`: compare genesis hash on connect, invalidate cache if changed (edge case from spec)
- [x] T087 [P] Add file lock mechanism to filesystem StorageAdapter in `packages/cli/src/adapters/fs-storage.ts`: prevent concurrent wallet file corruption (edge case from spec)
- [x] T088 Run quickstart.md validation: execute all commands from quickstart guide against devnet, verify each succeeds
- [x] T089 Final dependency audit: verify all deps are pinned to exact versions in yarn.lock, review each for known vulnerabilities (SR-006)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 Deploy (Phase 3)**: Depends on Phase 2
- **US2 Agent (Phase 4)**: Depends on Phase 2 + partial US1 (deploy orchestration for the deploy step, but call/state are independent)
- **US3 Wallet Mgmt (Phase 5)**: Depends on Phase 2
- **US4 CI Pipeline (Phase 6)**: Depends on Phase 2 + requires wallet generate (can start in parallel with US1-US3, wallet commands are independent)
- **US5 Browser (Phase 7)**: Depends on Phase 2 (core library must be stable)
- **US6 TUI (Phase 8)**: Depends on Phase 2 (wraps core operations)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (Deploy)**: After Phase 2 — no dependencies on other stories
- **US2 (Agent)**: After Phase 2 — shares deploy with US1 but call/state are independent
- **US3 (Wallet Mgmt)**: After Phase 2 — fully independent
- **US4 (CI Pipeline)**: After Phase 2 — wallet commands are self-contained; integration test needs deploy from US1
- **US5 (Browser)**: After Phase 2 — independent (different platform adapter)
- **US6 (TUI)**: After Phase 2 — independent (presentation layer over core)

### Within Each User Story

- Tests MUST be written and FAIL before implementation (Constitution IV)
- Core logic before CLI command wrappers
- Orchestration before CLI integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks T003-T012 can run in parallel
- Foundational: T016-T018 parallel; T019-T024 (test+impl pairs) sequential per module; T025-T032 parallel
- US1: T034-T036 parallel (tests + artifact loader); T037-T040 sequential
- US2: T041-T042 parallel; T043-T046 sequential
- US3: T048-T050 parallel; T051-T058 mostly parallel (different commands/files)
- US4: T059-T063 all parallel (different wallet commands); T064-T066 sequential
- US5: T067-T068 parallel; T069-T071 sequential
- US6: T072-T077 all parallel (different screens); T078-T079 sequential
- Polish: T080-T087 all parallel

---

## Implementation Strategy

### MVP First (User Story 1 + 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: US1 Deploy
4. Complete Phase 4: US2 Agent Call/State
5. **STOP and VALIDATE**: Deploy + call + state cycle works end-to-end
6. SC-001 (deploy <2 min) and SC-002 (agent ≤5 commands) met

### Incremental Delivery

1. Setup + Foundational → Core library ready
2. US1 (Deploy) → First useful command (MVP!)
3. US2 (Agent) → Agent workflow complete
4. US3 (Wallet Mgmt) → Developer daily-use commands
5. US4 (CI Pipeline) → Team workflow integration
6. US5 (Browser) → Cross-platform library
7. US6 (TUI) → Interactive dashboard
8. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers after Foundational:
- Developer A: US1 (Deploy) + US2 (Agent) — P1 stories, shared transaction builder
- Developer B: US3 (Wallet Mgmt) + US4 (CI) — P2 stories, wallet commands
- Developer C: US5 (Browser) + US6 (TUI) — P3 stories, platform adapters
- All stories integrate independently against the core library

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Verify tests fail before implementing (Constitution IV)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Security-critical tasks (T019-T024) MUST follow Red-Green-Refactor
