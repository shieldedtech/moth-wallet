> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Feature Specification: Isomorphic Wallet Tool

**Feature Branch**: `001-isomorphic-wallet-tool`
**Created**: 2026-05-01
**Status**: Draft
**Input**: MPS-0003 — Isomorphic Wallet Tool for CLI, Browser, and Agentic Workflows

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy a Compiled Contract (Priority: P1)

A DApp developer has a compiled Compact contract and wants to deploy it to a
Midnight network. Today this requires 150-250 lines of boilerplate covering
provider configuration, wallet setup, DUST registration, proof generation, and
transaction submission. The developer wants a single command that handles all of
this and returns the contract address.

**Why this priority**: Deployment is the first thing every developer needs after
compiling a contract. It is the gateway operation — nothing else works until a
contract is on-chain. Reducing deployment from 30-60 minutes of scaffolding to
under 60 seconds removes the single largest barrier to Midnight adoption.

**Independent Test**: Run the deploy command against a local devnet with a
pre-compiled contract and verify the returned contract address is queryable
on-chain.

**Acceptance Scenarios**:

1. **Given** a compiled contract artifact and a funded wallet, **When** the user
   runs the deploy command targeting devnet, **Then** the tool deploys the
   contract and returns the contract address within 60 seconds.
2. **Given** a compiled contract with witness requirements, **When** the user
   provides a witness file alongside the deploy command, **Then** the tool loads
   the witnesses and completes deployment successfully.
3. **Given** the deploy command with `--output json`, **When** deployment
   succeeds, **Then** the output is valid JSON containing at minimum the
   contract address and transaction identifier.
4. **Given** a wallet with insufficient DUST, **When** the user runs the deploy
   command, **Then** the tool reports a clear error indicating DUST is required
   and how to obtain it.

---

### User Story 2 - AI Agent Deploys and Tests a Contract (Priority: P1)

An AI coding agent (Claude Code, Cursor, or similar) has written and compiled a
Compact contract. The agent needs to deploy the contract, call a circuit, and
verify the result — all through non-interactive commands with structured output.
Today, agents must generate throwaway TypeScript deployment scripts that break
with each SDK version change.

**Why this priority**: AI-assisted development is a primary workflow for
Midnight. Agents that can write and compile contracts but cannot deploy or test
them leave the developer stuck at the last mile. This story shares infrastructure
with UC1 (deploy) and adds circuit calling, making it a natural P1 companion.

**Independent Test**: Simulate an agent workflow: deploy a counter contract, call
the increment circuit, read contract state, and verify the counter incremented —
all using non-interactive commands with JSON output parsed between steps.

**Acceptance Scenarios**:

1. **Given** a deployed contract, **When** an agent runs the call command with
   circuit name and arguments in JSON format, **Then** the tool executes the
   circuit and returns structured output with the transaction result.
2. **Given** the call command with `--output json`, **When** the circuit
   execution succeeds, **Then** the output contains the transaction identifier
   and any return values.
3. **Given** a deployed contract address, **When** the agent queries contract
   state, **Then** the tool returns the current public ledger state as
   structured data.
4. **Given** an invalid circuit name or malformed arguments, **When** the agent
   runs the call command, **Then** the tool returns a non-zero exit code and a
   descriptive error message in the requested output format.

---

### User Story 3 - Manage Wallet from the Terminal (Priority: P2)

A developer wants to check balances, transfer NIGHT tokens, register for DUST,
monitor DUST status, and inspect contract state — all from the terminal without
leaving their IDE. Today this requires switching to the Lace browser extension or
running an interactive TUI session that cannot return single values to the shell.

**Why this priority**: Daily wallet operations are the most frequent interaction
a developer has with the network. Non-interactive commands that compose with
shell tools (piping into `jq`, scripting with bash) make the tool useful beyond
deployment.

**Independent Test**: Run balance, transfer, and DUST status commands
independently, verifying each returns correct data and meaningful exit codes.

**Acceptance Scenarios**:

1. **Given** a configured wallet, **When** the user runs the balance command,
   **Then** the tool displays NIGHT and DUST balances in human-readable format
   (default) or JSON (`--output json`).
2. **Given** a funded wallet, **When** the user runs a transfer command
   specifying amount, token type, and recipient address, **Then** the tool
   submits the transaction and returns a confirmation with the transaction
   identifier.
3. **Given** an unregistered wallet, **When** the user runs the DUST register
   command, **Then** the tool completes registration and confirms the
   registration status.
4. **Given** a registered wallet, **When** the user runs the DUST status
   command, **Then** the tool displays current DUST balance, accrual rate, and
   registration status.
5. **Given** a batch transfer file listing multiple recipients and amounts,
   **When** the user runs a batch transfer command, **Then** the tool processes
   all transfers and reports per-item success/failure with exit code 0 (all
   succeeded), 1 (all failed), or 2 (partial failure).

---

### User Story 4 - CI Pipeline Runs On-Chain Integration Tests (Priority: P2)

A development team maintains a DApp with multiple Compact contracts. Their CI
pipeline compiles contracts and runs simulator tests. They want to add on-chain
integration tests that deploy contracts to devnet, call circuits, and assert on
results — without maintaining fragile custom scripts.

**Why this priority**: CI integration extends the tool's value from individual
developer productivity to team workflow reliability. It validates that contracts
work on a live network, catching issues that simulator tests miss.

**Independent Test**: Run a CI-style script that generates an ephemeral wallet,
funds it, deploys a contract, calls a circuit, asserts the result, then
discards the wallet. Verify the full cycle completes with meaningful exit codes.

**Acceptance Scenarios**:

1. **Given** a CI environment with the tool installed, **When** the pipeline
   runs wallet generate with JSON output, **Then** a new wallet is created and
   wallet credentials are returned as structured data.
2. **Given** an ephemeral wallet on devnet, **When** the pipeline requests an
   airdrop, **Then** the wallet receives test tokens and the balance is
   confirmed via a subsequent balance query.
3. **Given** a funded ephemeral wallet, **When** the pipeline deploys a
   contract, calls a circuit, and queries state, **Then** each command returns
   structured output with meaningful exit codes (0 for success, non-zero for
   failure).
4. **Given** any command failure during the pipeline, **When** the tool returns
   a non-zero exit code, **Then** the error output includes a machine-parseable
   error category and human-readable description.

---

### User Story 5 - Browser-Based Wallet Operations (Priority: P3)

A DApp developer is building a web application that needs wallet operations
(balance queries, transaction construction, state inspection) without requiring
users to install the Lace browser extension — for example, an admin dashboard,
demo app, or developer tool running in the browser.

**Why this priority**: Browser compatibility makes the tool's logic reusable
across platforms, but the primary audience (developers, CI, agents) is served by
the CLI stories first. Browser support extends reach without blocking core value
delivery.

**Independent Test**: Load the wallet library in a browser environment, perform
a balance query and contract state inspection against a devnet, and verify
results match CLI output for the same operations.

**Acceptance Scenarios**:

1. **Given** the wallet library loaded in a modern browser, **When** the
   application initializes a wallet from a mnemonic, **Then** the wallet syncs
   with the network and reports balances.
2. **Given** a synced browser wallet, **When** the application constructs and
   submits a transfer transaction, **Then** the transaction completes and the
   updated balance is reflected.
3. **Given** a deployed contract address, **When** the application queries
   contract state through the browser library, **Then** the returned state
   matches what the CLI reports for the same contract.
4. **Given** the browser library using local storage for wallet persistence,
   **When** the user closes and reopens the browser, **Then** the wallet state
   is restored without requiring re-sync from genesis.

---

### User Story 6 - Interactive Terminal Dashboard (Priority: P3)

A developer wants a live dashboard showing wallet state, network status, sync
progress, and recent transactions — similar to existing community TUI tools but
backed by the same engine as the non-interactive CLI commands.

**Why this priority**: The interactive TUI provides a richer experience for
developers who prefer visual feedback, but every operation it exposes is already
available as a non-interactive command from higher-priority stories. The TUI is a
presentation layer over existing capabilities.

**Independent Test**: Launch the interactive mode, verify it displays wallet
balance, network sync status, and allows executing a transfer through the
interactive interface.

**Acceptance Scenarios**:

1. **Given** a configured wallet, **When** the user launches the tool without
   subcommands (or with an explicit TUI command), **Then** an interactive
   dashboard displays showing wallet balances, network status, and sync
   progress.
2. **Given** the interactive dashboard, **When** the user navigates to the
   transfer screen and submits a transfer, **Then** the transaction is
   processed and the dashboard updates with the result.
3. **Given** the interactive dashboard, **When** the network sync progresses,
   **Then** the dashboard updates in real time showing block height, slot, and
   sync percentage.

---

### Edge Cases

- What happens when the tool cannot connect to the configured network endpoint?
  The tool MUST return a clear error within 10 seconds (connection timeout), not
  hang indefinitely.
- What happens when a wallet file is corrupted or from an incompatible version?
  The tool MUST detect corruption via authenticated encryption validation and
  report the specific error, not silently produce wrong results.
- What happens when proof generation fails mid-transaction? The tool MUST
  report the failure, not leave the transaction in an ambiguous state. No funds
  should be at risk from a failed proof.
- What happens when multiple instances of the tool access the same wallet file
  concurrently? The tool MUST use file locking or equivalent mechanism to
  prevent data corruption. If a lock cannot be acquired, report which process
  holds it.
- What happens when the network resets (e.g., devnet genesis reset)? The tool
  MUST detect stale cached state and offer to re-sync rather than operating on
  invalid data.
- What happens when the proof server is unreachable before a transaction? The
  tool MUST fail fast with an actionable error (server address, startup
  guidance) rather than attempting the operation and timing out during proof
  generation.
- What happens when a transaction times out waiting for confirmation? The tool
  MUST report the last known transaction state (submitted but unconfirmed) and
  exit with a timeout-specific exit code. No automatic retry — the caller
  decides whether to resubmit.
- What happens when a batch transfer partially fails (e.g., 8 of 10 succeed)?
  The tool MUST return exit code 2 (partial failure) with per-item detail
  showing which transfers succeeded and which failed, including failure reasons.

## Clarifications

### Session 2026-05-01

- Q: How should the tool handle diagnostic/debug output? → A: `--verbose` flag for debug output to stderr; quiet by default; structured log lines with timestamps.
- Q: What happens when a transaction is submitted but confirmation doesn't arrive? → A: Configurable `--timeout <seconds>` with sensible defaults per operation; no auto-retry; clear exit codes on timeout.
- Q: How do CLI commands handle an unsynced or partially synced wallet? → A: Auto-sync in background; cache state between runs; commands needing current state wait for tip; read-only queries bypass wallet sync via indexer.
- Q: What happens when the proof server is unreachable? → A: Pre-flight health check before transaction commands; fail fast with actionable error including server address and startup guidance; configurable endpoint via `--proof-server`.
- Q: What exit code for partial batch transfer failure? → A: Exit 0 = all succeeded; exit 1 = all failed; exit 2 = partial failure; per-item detail in output.

## Requirements *(mandatory)*

### Functional Requirements

**Wallet Management**

- **FR-001**: The tool MUST generate new wallets from BIP-39 24-word mnemonics
- **FR-002**: The tool MUST import existing wallets from BIP-39 mnemonics and
  hex seeds
- **FR-003**: The tool MUST support managing multiple named wallets with the
  ability to add, remove, list, and switch between them
- **FR-004**: The tool MUST encrypt wallet files at rest using authenticated
  encryption with a user-provided passphrase
- **FR-005**: The tool MUST set restrictive file permissions (owner-only read/
  write) on wallet files
- **FR-006**: The tool MUST prompt for passphrases interactively when a terminal
  is available, and accept them via environment variable for non-interactive use

**Token Operations**

- **FR-007**: The tool MUST support transferring NIGHT tokens (both shielded and
  unshielded) to a specified recipient address
- **FR-008**: The tool MUST support batch transfers to multiple recipients from a
  single command
- **FR-009**: The tool MUST display wallet balances for both NIGHT and DUST
  tokens
- **FR-010**: The tool MUST support DUST registration and deregistration
- **FR-011**: The tool MUST display DUST status including balance, accrual rate,
  and registration state

**Contract Operations**

- **FR-012**: The tool MUST deploy compiled Compact contract artifacts to a
  specified network
- **FR-013**: The tool MUST accept optional witness provider files for contract
  deployment
- **FR-014**: The tool MUST support calling named circuits on deployed contracts
  with arguments provided as structured data
- **FR-015**: The tool MUST query and display the public ledger state of a
  deployed contract
- **FR-016**: The tool SHOULD support token minting for fungible tokens on
  deployed contracts. *Deferred*: requires a standard fungible token contract
  artifact. The `moth mint` command is scaffolded but not wired to a live
  contract in v1

**Output and Automation**

- **FR-017**: Every command MUST support `--output json` for machine-parseable
  structured output
- **FR-018**: Every command MUST return meaningful exit codes (0 for success,
  distinct non-zero codes for different failure categories)
- **FR-019**: Human-readable output MUST be the default when no output format
  is specified
- **FR-020**: Error messages MUST include an error category and actionable
  description without leaking private wallet data
- **FR-020a**: The tool MUST support a `--verbose` flag that emits structured
  debug output (timestamped log lines) to stderr. Default behavior is quiet
  (errors only to stderr, data to stdout)
- **FR-020b**: Every transaction-producing command MUST support a `--timeout
  <seconds>` flag with sensible per-operation defaults (60s deploy, 30s
  transfer, 30s circuit call). On timeout, the command MUST exit with a
  distinct non-zero code and report the last known transaction state. The tool
  MUST NOT auto-retry transactions

**Network Configuration**

- **FR-021**: The tool MUST support multiple networks: local devnet, preview,
  and preprod
- **FR-022**: Network endpoints MUST be configurable via command flags,
  environment variables, or a configuration file (in that precedence order)
- **FR-023**: The tool MUST default to localhost devnet when no network is
  specified
- **FR-024**: The tool MUST support custom networks with non-standard ports

**Cross-Environment Operation**

- **FR-025**: The wallet MUST provide a browser-compatible package
  (`@moth/browser`) that exposes wallet management, indexer queries, and
  balance operations via browser-native APIs (IndexedDB, Web Crypto). The
  core package (`@moth/core`) is Node.js-first; browser compatibility is
  achieved through the browser adapter package, not by making core isomorphic
- **FR-026**: The browser variant MUST use appropriate storage adapters (local
  browser storage instead of filesystem) while maintaining the same operation
  semantics as the CLI
- **FR-027**: The tool MUST provide an interactive terminal dashboard mode when
  launched without subcommands or with an explicit dashboard command

**CI/Automation Support**

- **FR-028**: The tool MUST support generating ephemeral wallets for CI use
  with structured output containing all necessary credentials
- **FR-029**: The tool MUST support requesting test token airdrops on
  development networks
- **FR-030**: The tool MUST install with a single command and work with sensible
  defaults requiring no configuration for devnet use

**Sync & Proof Infrastructure**

- **FR-031**: The tool MUST automatically sync wallet state in the background on
  first use and cache state between runs. Commands requiring current balances
  or submitting transactions MUST wait until sync reaches the chain tip.
  Read-only queries (contract state inspection) MUST bypass wallet sync and
  query the indexer directly
- **FR-032**: Transaction-producing commands MUST perform a pre-flight health
  check on the proof server before beginning the operation. If the proof server
  is unreachable, the command MUST fail immediately with an actionable error
  message including the configured server address and guidance on how to start
  one. The proof server endpoint MUST be configurable via `--proof-server`

**Exit Code Semantics**

- **FR-033**: Batch operations MUST use a three-tier exit code scheme: exit 0
  when all items succeeded, exit 1 when all items failed, exit 2 when some
  items succeeded and others failed. Per-item success/failure detail MUST be
  included in the command output regardless of format

### Key Entities

- **Wallet**: A named identity containing derived keys for shielded, unshielded,
  and DUST operations. Encrypted at rest. Contains BIP-39 mnemonic, derived HD
  keys across five roles, network associations, and sync state.
- **Network**: A configured Midnight network endpoint (devnet, preview, preprod,
  or custom). Defines node RPC and indexer connection parameters.
- **Contract Artifact**: The compiled output from the Compact compiler
  (`compact compile`). Contains the circuit definitions, initial state, and metadata
  needed for deployment.
- **Transaction**: An on-chain operation (transfer, deployment, circuit call,
  DUST registration). Has an identifier, status, and structured result.
- **Witness Provider**: User-supplied logic that provides private inputs to
  contract circuits during deployment or circuit calls.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with a compiled contract and the tool installed
  deploys to devnet in under 2 minutes, including wallet creation and DUST
  registration
- **SC-002**: An AI coding agent completes a deploy-call-verify cycle in 5 or
  fewer discrete commands with at least 90% success rate
- **SC-003**: A development team integrates on-chain tests into an existing CI
  pipeline in under 1 hour
- **SC-004**: Every wallet operation available in existing community TUI tools
  (9 feature categories: dashboard, transfers, minting, deployment, keys, DUST,
  network config, contract state, logs) is available as a non-interactive command
- **SC-005**: Balance and status queries return results within 5 seconds
- **SC-006**: Transfer transactions complete within 30 seconds
- **SC-007**: Contract deployment completes within 60 seconds including proof
  generation
- **SC-008**: The tool starts and returns help output in under 2 seconds with no
  heavy initialization
- **SC-009**: The wallet library executes balance queries, transaction
  construction, and contract state inspection in a browser environment with
  results matching CLI output for the same operations
- **SC-010**: No wallet passphrase, mnemonic, or private key appears in command
  output, log files, process arguments, or error messages under any
  circumstances

## Assumptions

- Developers have a local devnet running or access to preview/preprod — the tool
  does not manage network infrastructure
- The Compact compiler (`compact compile`) is installed separately and produces
  artifacts in its current output format
- An external proof server is available for proof generation (the tool connects
  to one; it does not bundle a prover in v1)
- V1 includes all three runtime targets: non-interactive CLI commands, browser
  library, and interactive TUI mode — delivering the full MPS feature set from
  the initial release
- Browser environments have access to modern web platform features (Web Crypto
  API, IndexedDB, WebAssembly) — no legacy browser support
- Wallet files are not portable between CLI and browser environments in v1;
  each environment manages its own encrypted storage
- The tool uses a hybrid approach: transaction submission via a minimal SCALE
  encoder for direct node communication (no @polkadot/api), and wallet sync
  via the official Midnight wallet SDK (WalletFacade, ShieldedWallet,
  UnshieldedWallet, DustWallet, HD key derivation). This balances independence
  from @polkadot/api with the battle-tested sync pipeline from the wallet SDK
- Users on CI environments can provide wallet passphrases via environment
  variables without interactive prompts
- The tool targets the current Midnight protocol version and does not maintain
  backward compatibility with prior protocol versions
- Circuit arguments are specified via `--args` which accepts either inline JSON
  (`--args '{"amount": 100}'`) or a file reference (`--args @path/to/args.json`).
  The tool auto-detects the format: values starting with `@` are treated as file
  paths, all others as inline JSON
