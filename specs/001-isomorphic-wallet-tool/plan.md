> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Implementation Plan: Isomorphic Wallet Tool

**Branch**: `001-isomorphic-wallet-tool` | **Date**: 2026-05-01 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-isomorphic-wallet-tool/spec.md`

## Summary

Build a wallet tool that provides single-command wallet operations (deploy,
transfer, balance, DUST management, contract interaction) across three runtime
contexts: non-interactive CLI, browser library, and interactive TUI. Transaction
submission uses a minimal SCALE encoder for direct node communication (no
@polkadot/api). Wallet sync uses the official Midnight wallet SDK (WalletFacade
with ShieldedWallet, UnshieldedWallet, DustWallet). The core package is
Node.js-first; browser compatibility is provided via the `@moth/browser`
adapter package.

## Technical Context

**Language/Version**: TypeScript 5.5+ / Node.js 22+
**Primary Dependencies**: `@scure/bip39` + `@scure/bip32` (audited HD key
derivation), `@noble/ciphers` (authenticated encryption), `graphql-request`
(indexer queries), `@midnight-ntwrk/compact-js`, `@midnight-ntwrk/compact-runtime`,
`@midnight-ntwrk/ledger-v8`, `@midnight-ntwrk/midnight-js-types`,
`@midnight-ntwrk/midnight-js-contracts`, `@midnight-ntwrk/midnight-js-network-id`
(transaction construction and contract execution), `ink` + `react` (TUI),
`oclif` (CLI framework)
**Storage**: Filesystem with encrypted JSON files (CLI); IndexedDB with Web
Crypto API encryption (browser); in-memory cache for sync state (both)
**Testing**: Vitest (unit + integration), Playwright (browser library)
**Target Platform**: Node.js 22+ (CLI/TUI), modern browsers — Chrome, Firefox,
Safari (library)
**Project Type**: TypeScript monorepo — isomorphic core library + CLI shell +
browser adapter + TUI shell
**Performance Goals**: <60s deploy, <30s transfer, <5s queries, <2s CLI startup
**Constraints**: Direct node communication via minimal SCALE encoder (no
@polkadot/api). Uses @midnight-ntwrk wallet SDK packages for wallet sync
(WalletFacade, ShieldedWallet, UnshieldedWallet, DustWallet) and HD key
derivation. Core package is Node.js-first; browser compatibility via
`@moth/browser` adapter package with IndexedDB storage. Encrypted keystore
mandatory.
**Scale/Scope**: Single-user developer tool. 4 packages, ~33 functional
requirements, 6 user stories.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status | Notes |
|-----------|------|--------|-------|
| I. Privacy by Default | No private data in logs, errors, public state | PASS | FR-020 prohibits key leakage in errors; FR-020a verbose mode writes to stderr with sensitive data filtering; SC-010 enforces zero key exposure |
| II. Cryptographic Safety | Audited primitives only; BIP-39/32 standards | PASS | `@scure/bip39`, `@scure/bip32`, `@noble/ciphers` are audited by Trail of Bits; no custom crypto |
| III. Secure Key Management | Encrypted at rest; zeroed after use; no keys in CLI args | PASS | FR-004 authenticated encryption; FR-005 file permissions; FR-006 passphrase via env var (not CLI arg); SR-001 prohibits mnemonics in process args |
| IV. Test-First Development | TDD mandatory for security-critical code | PASS | Red-Green-Refactor enforced; Vitest for unit/integration; tests before implementation per spec |
| V. Minimal Attack Surface | Justified dependencies; no extras | PASS | 20+ production dependencies in core: 3 audited crypto libs, 8 wallet SDK packages (sync, HD, address), 4 official SDK providers (proof, indexer, ZK config, private state), 3 GraphQL/WS, 2 ledger/network-id, 2 contract SDK. Minimal SCALE encoder (89 lines) for direct extrinsic submission; @polkadot/api present as transitive dependency of wallet SDK |
| SR-001 | No mnemonics in process args, env vars, or logs | PASS | Mnemonics via stdin pipe or interactive prompt only. No env var support (removed per SR-001). Verbose output filters sensitive data |
| SR-002 | Validate RPC responses | PASS | Direct RPC client will validate response schemas before acting |
| SR-003 | Explicit user confirmation for signing | PASS | FR-017 structured output; CLI prompts for confirmation; `--yes` flag for CI with explicit opt-in |
| SR-004 | Authenticated encryption for wallet files | PASS | FR-004 + encrypt-then-MAC via `@noble/ciphers` ChaCha20-Poly1305 |
| SR-005 | No private state in error messages | PASS | FR-020 + SC-010 |
| SR-006 | Pinned dependencies | PASS | Yarn lockfile; exact versions in package.json |
| SR-007 | Local proof verification before submission | PASS | Proof generation runs via a dedicated proof server (local or configured). The wallet facade submits unproven transactions to the proof server, receives proven transactions back, and only submits proven transactions to the network. Failed proof generation halts the flow — no unproven transaction reaches the node. FR-032 adds a pre-flight health check on the proof server before starting |

**All gates pass. No complexity tracking entries required.**

## Project Structure

### Documentation (this feature)

```text
specs/001-isomorphic-wallet-tool/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── cli-commands.md  # CLI command interface contracts
│   └── core-api.md      # Core library public API contract
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/
├── core/                          # Isomorphic wallet engine
│   ├── src/
│   │   ├── wallet/                # Key derivation, mnemonic handling, multi-wallet
│   │   ├── network/               # RPC client, GraphQL indexer client
│   │   ├── transaction/           # Transaction construction, signing, submission
│   │   ├── proof/                 # Proof server client, pre-flight health check
│   │   ├── contract/              # Artifact loader, witness loader, args parser, state query
│   │   ├── providers/             # Custom providers bridging SDK interfaces
│   │   ├── sync/                  # Background sync engine, state cache
│   │   ├── storage/               # Storage adapter interface (abstract)
│   │   └── types/                 # Shared type definitions, exit codes
│   └── tests/
│       ├── unit/                  # Pure logic tests (key derivation, crypto)
│       └── integration/           # Tests against local devnet
├── cli/                           # Non-interactive CLI shell
│   ├── src/
│   │   ├── commands/              # oclif commands (deploy, transfer, balance, etc.)
│   │   ├── adapters/              # Filesystem storage, terminal passphrase prompt
│   │   └── formatters/            # Human-readable + JSON output formatters
│   └── tests/
├── browser/                       # Browser adapter package
│   ├── src/
│   │   ├── adapters/              # IndexedDB storage, Web Crypto passphrase
│   │   └── index.ts               # Public library API
│   └── tests/
└── tui/                           # Interactive terminal dashboard
    ├── src/
    │   ├── screens/               # Dashboard, transfers, DUST, deploy, state
    │   ├── components/            # Shared Ink components
    │   └── hooks/                 # React hooks wrapping core operations
    └── tests/

turbo.json                         # Turborepo pipeline config
package.json                       # Workspace root
yarn.lock                          # Pinned dependency lockfile
tsconfig.base.json                 # Shared TypeScript config
vitest.workspace.ts                # Vitest workspace config
```

**Structure Decision**: Monorepo with 4 packages. The `core` package is the
isomorphic engine with zero platform-specific imports — it defines a
`StorageAdapter` interface that `cli` implements with filesystem operations and
`browser` implements with IndexedDB. The `tui` package depends on `core` (same
as `cli`) and uses React/Ink for rendering. Turborepo manages build ordering
(`core` → `cli`/`browser`/`tui`).

## Complexity Tracking

> No constitution violations to justify. All gates pass.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 4-package monorepo | Isomorphic requirement demands shared core + platform adapters | Single package cannot serve both Node.js CLI and browser without bundling platform-specific code |
