> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Research: Isomorphic Wallet Tool

**Date**: 2026-05-01
**Source**: midnight-wallet SDK, midnight-indexer, midnight-js source code at
`~/code/midnight-code/`

## Decision 1: Node Communication Protocol

**Decision**: Polkadot JSON-RPC over WebSocket (port 9944)

**Rationale**: Midnight's node is Substrate-based. The wallet SDK's
`PolkadotNodeClient` (midnight-wallet/packages/node-client) uses `@polkadot/api`
with `WsProvider` to connect. Transaction submission uses the Substrate extrinsic
system via `api.tx.midnight.sendMnTransaction()`. The SDK wraps this in an
Effect-based stream that emits lifecycle events: Submitted → InBlock → Finalized.

**Source-verified RPC surface** (from `PolkadotNodeClient.ts`):

| Operation | Substrate API Call | Description |
|-----------|--------------------|-------------|
| Submit transaction | `api.tx.midnight.sendMnTransaction(hex)` | Submits serialized Midnight transaction as extrinsic |
| Watch submission | `.send(callback)` subscription | Emits: Ready, Future, Broadcast, Retracted, InBlock, Finalized, FinalityTimeout, Usurped, Dropped, Invalid |
| Get genesis block | `api.rpc.chain.getBlock(genesisHash)` | Retrieves genesis block extrinsics |
| Connection management | `api.connect()` / `api.disconnect()` | WebSocket lifecycle with reconnection support |

**Default port**: 9944 (single port for both WebSocket and HTTP — modern
Substrate merged them), confirmed from docker-compose.yaml and endpoint test
scripts.

**Midnight-specific RPC methods** (from `pallets/midnight/rpc/src/lib.rs`):

| Method | Description |
|--------|-------------|
| `midnight_contractState` | Contract state by address (optional block hash) |
| `midnight_zswapStateRoot` | Zswap state root hash |
| `midnight_ledgerStateRoot` | Ledger state root hash |
| `midnight_apiVersions` | Supported RPC API versions (currently `[2]`) |
| `midnight_ledgerVersion` | Ledger version string (e.g., "0.8.5") |

**Sidechain RPC** (from `pallet-sidechain-rpc`):

| Method | Description |
|--------|-------------|
| `sidechain_getStatus` | Current epoch, slot, slots-per-epoch, slot duration |
| `sidechain_getEpochCommittee` | Validator committee for a given epoch |

**Note**: The midnight-js testkit (`testkit-js/src/client/node-client.ts`) uses
raw HTTP JSON-RPC POST requests (via `axios`) for `midnight_contractState` and
`midnight_ledgerVersion` — not `@polkadot/api`. This validates the direct RPC
approach for read operations.

**Alternatives considered**: We chose the direct approach with a minimal SCALE
encoder (89 lines) rather than pulling in `@polkadot/api`. For read operations
(contract state, block info, chain status), raw HTTP JSON-RPC is proven by the
testkit. For transaction submission, the minimal encoder handles SCALE codec
encoding and transaction submission uses `author_submitExtrinsic` via HTTP
JSON-RPC. This avoids the large `@polkadot/api` dependency tree.

**Implication for isomorphic core**: The minimal SCALE encoder is pure
TypeScript with no platform-specific dependencies, making it fully isomorphic.
Read-only queries use raw HTTP JSON-RPC. Transaction submission uses
`author_submitExtrinsic` via HTTP JSON-RPC. No WebSocket polyfills are needed
for the core submission path.

## Decision 2: Indexer Communication Protocol

**Decision**: GraphQL over HTTP (queries) + WebSocket (subscriptions), port 8088

**Rationale**: The indexer exposes a comprehensive GraphQL API (schema-v4). The
wallet SDK's `indexer-client` package implements two client types:
`HttpQueryClient` for queries and `WsSubscriptionClient` for subscriptions.

**Source-verified GraphQL surface** (from `schema-v4.graphql`):

### Queries
| Query | Parameters | Returns | Use Case |
|-------|-----------|---------|----------|
| `block` | `offset?: BlockOffset` | `Block` | Get block by hash/height, latest if omitted |
| `transactions` | `offset: TransactionOffset!` | `[Transaction!]!` | Find transactions by hash or identifier |
| `contractAction` | `address: HexEncoded!, offset?: ContractActionOffset` | `ContractAction` | Get contract state (deploy, call, update) |
| `dustGenerationStatus` | `cardanoRewardAddresses: [CardanoRewardAddress!]!` | `[DustGenerationStatus!]!` | DUST registration status, generation rate, capacity |

### Mutations
| Mutation | Parameters | Returns | Use Case |
|---------|-----------|---------|----------|
| `connect` | `viewingKey: ViewingKey!` | `HexEncoded!` (session ID) | Start wallet sync session for shielded tx indexing |
| `disconnect` | `sessionId: HexEncoded!` | `Unit!` | End wallet sync session |

### Subscriptions
| Subscription | Parameters | Returns | Use Case |
|-------------|-----------|---------|----------|
| `blocks` | `offset?: BlockOffset` | `Block!` | Real-time block notifications |
| `contractActions` | `address: HexEncoded!, offset?: BlockOffset` | `ContractAction!` | Real-time contract state changes |
| `shieldedTransactions` | `sessionId: HexEncoded!, index?: Int` | `ShieldedTransactionsEvent!` | Shielded tx sync (requires `connect` first) |
| `unshieldedTransactions` | `address: UnshieldedAddress!, transactionId?: Int` | `UnshieldedTransactionsEvent!` | Unshielded UTXO tracking |
| `dustLedgerEvents` | `id?: Int` | `DustLedgerEvent!` | DUST lifecycle events |
| `zswapLedgerEvents` | `id?: Int` | `ZswapLedgerEvent!` | Zswap state events |

### Key Types
- `ContractAction` interface: `ContractDeploy`, `ContractCall`, `ContractUpdate`
- `Transaction` interface: `RegularTransaction`, `SystemTransaction`
- `RegularTransaction` includes: fees, identifiers, merkle tree root, contract
  actions, unshielded UTXOs, zswap/dust events
- `DustGenerationStatus`: cardanoRewardAddress, dustAddress, registered,
  nightBalance, generationRate, maxCapacity, currentCapacity
- `UnshieldedUtxo`: owner, tokenType, value, intentHash, initialNonce,
  registeredForDustGeneration

**Default port**: 8088 (confirmed from docker-compose.yaml)

**Implication for isomorphic core**: GraphQL queries over HTTP and WebSocket
subscriptions are natively supported in browsers. The `graphql-request` library
or a lightweight fetch-based client works in both environments. This is the
cleanest isomorphic boundary in the architecture.

## Decision 3: Proof Server Protocol

**Decision**: HTTP REST on port 6300

**Rationale**: The wallet SDK's `HttpProverClient`
(midnight-wallet/packages/prover-client) communicates with the proof server via
HTTP POST requests using binary payloads.

**Source-verified endpoints** (from `HttpProverClient.ts`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/prove` | POST | Submit serialized unproven transaction, receive proven transaction (binary Uint8Array in/out) |
| `/check` | POST | Validate transaction proof data (binary in, parsed result out) |
| `/health` | GET | Health check |
| `/ready` | GET | Readiness check with job queue status |
| `/version` | GET | Server version string |
| `/proof-versions` | GET | Supported proof versions (e.g., `["V2"]`) |

The client uses `ledger.createProvingPayload()` to serialize the request and
the proof server returns the proven transaction as binary. The client retries
on 502/503/504 with exponential backoff (2s base, 3 retries). Default timeout
is 300,000ms (5 minutes).

**Default port**: 6300

**Alternatives considered**: WASM-based local proving (`WasmProver.ts` exists in
the SDK). The SDK supports both HTTP server proving and local WASM proving via
the same `ProverClient` interface. For v1, we default to HTTP (external server)
per spec assumptions, but the `ProverClient` abstraction supports adding WASM
proving later.

## Decision 4: HD Key Derivation

**Decision**: BIP-44 path `m/44'/2400'/{account}'/{role}/{index}` using
`@scure/bip32`

**Rationale**: Source-verified from `HDWallet.ts` in
midnight-wallet/packages/hd. The wallet SDK already uses `@scure/bip32`
(`HDKey.fromMasterSeed`). The derivation path uses:
- Purpose: 44 (BIP-44 standard)
- Coin type: 2400 (Midnight's registered coin type)
- Account: user-selectable (default 0)
- Role: one of 5 values (see below)
- Index: sequential key index

**Roles** (from source):

| Role | Value | Purpose |
|------|-------|---------|
| NightExternal | 0 | Unshielded (NIGHT) external addresses |
| NightInternal | 1 | Unshielded internal (change) addresses |
| Dust | 2 | DUST wallet keys |
| Zswap | 3 | Shielded transaction keys |
| Metadata | 4 | Metadata signing keys |

The `HDWallet` class provides `clear()` to wipe private data from memory after
derivation — aligning with constitution principle III (Secure Key Management).

**Implication**: Our core can use `@scure/bip32` directly (same library the SDK
uses). The derivation path and role constants must match exactly.

## Decision 5: Isomorphic Dependencies

**Decision**: Use audited, pure-JS cryptographic libraries

| Library | Version | Isomorphic | Audit Status | Purpose |
|---------|---------|------------|--------------|---------|
| `@scure/bip39` | 2.2.0 | Yes (pure JS) | Trail of Bits | Mnemonic generation/validation |
| `@scure/bip32` | 2.2.0 | Yes (pure JS) | Trail of Bits | HD key derivation (same as wallet SDK) |
| `@noble/ciphers` | 2.2.0 | Yes (pure JS) | Trail of Bits | ChaCha20-Poly1305 for keystore encryption |
| `@midnight-ntwrk/compact-js` | latest | Yes | Midnight | Compact contract interaction |
| `@midnight-ntwrk/compact-runtime` | latest | Yes | Midnight | Contract runtime execution |
| `@midnight-ntwrk/ledger-v8` | latest | Yes | Midnight | Ledger and transaction construction |
| `@midnight-ntwrk/midnight-js-types` | latest | Yes | Midnight | Shared type definitions |
| `@midnight-ntwrk/midnight-js-contracts` | latest | Yes | Midnight | Contract deployment and calling |
| `@midnight-ntwrk/midnight-js-network-id` | latest | Yes | Midnight | Network identification |
| `graphql-request` | 7.4.0 | Yes (fetch-based) | N/A (thin wrapper) | Indexer GraphQL queries |
| `oclif` | 4.23.0 | Node.js only (CLI shell) | N/A | CLI framework |
| `ink` | 7.0.1 | Node.js only (TUI shell) | N/A | Terminal UI |
| `react` | 19.2.5 | Yes | Meta | Required by Ink |

**Alternatives considered**:
- `noble/ed25519` for signing: Not needed — the Midnight ledger crate handles
  signing internally via the serialized transaction format
- Web Crypto API for encryption: Cross-platform but async-only API; `@noble/ciphers`
  provides synchronous ChaCha20-Poly1305 which simplifies key management code
- `urql` or `apollo-client` for GraphQL: Heavier than needed; `graphql-request`
  is minimal and fetch-based

## Decision 6: Storage Adapter Pattern

**Decision**: Abstract `StorageAdapter` interface in core, platform-specific
implementations in shell packages

**Rationale**: The wallet needs persistent storage for encrypted keystores and
sync cache. The storage mechanism differs by platform:

| Platform | Keystore | Sync Cache |
|----------|----------|------------|
| CLI | Encrypted JSON files (`~/.moth/`) | LevelDB or SQLite |
| Browser | IndexedDB with Web Crypto encryption | IndexedDB |
| TUI | Same as CLI (shares filesystem) | Same as CLI |

The adapter interface exposes: `read(key)`, `write(key, data)`, `delete(key)`,
`list(prefix)`, `exists(key)`. The core never imports platform-specific modules.

## Decision 7: Indexer SDK Query Patterns

**Decision**: Replicate midnight-js SDK query definitions using a lightweight
GraphQL client

**Rationale**: The midnight-js SDK (`indexer-public-data-provider`) uses Apollo
Client with typed query definitions. The SDK defines these operational queries
(from `query-definitions.ts`):

| SDK Constant | GraphQL Operation | Purpose |
|-------------|-------------------|---------|
| `BLOCK_QUERY` | `block` query | Block hash + height |
| `TX_ID_QUERY` | `transactions` query | Full transaction by hash/ID |
| `CONTRACT_STATE_QUERY` | `contractAction` query | Contract state only |
| `CONTRACT_AND_ZSWAP_STATE_QUERY` | `contractAction` query | State + zswap state |
| `DEPLOY_TX_QUERY` | `contractAction` query | Deploy tx chain |
| `UNSHIELDED_BALANCE_QUERY` | `contractAction` query | Token balances |
| `TXS_FROM_BLOCK_SUB` | `blocks` subscription | Real-time tx feed |
| `CONTRACT_STATE_SUB` | `contractActions` subscription | Contract state updates |
| `UNSHIELDED_BALANCE_SUB` | `contractActions` subscription | Balance updates |

The v4 schema also includes SPO/governance queries not used by the wallet SDK
but potentially useful for the `info` command. Our tool can use
`graphql-request` for HTTP queries and a standard `graphql-ws` client for
WebSocket subscriptions — no need for Apollo's heavier footprint.

## Open Research Items (deferred to implementation)

- **Midnight-specific Substrate RPC extensions**: The node may expose custom
  RPCs under a `midnight_` namespace beyond the standard Substrate RPCs. Not
  visible from the wallet SDK source (it only uses `api.tx.midnight` and
  `api.rpc.chain`). May need investigation during implementation.
- **Transaction serialization format**: The SDK uses `SerializedTransaction`
  from `@midnight-ntwrk/wallet-sdk-abstractions`. The exact binary format and
  how to construct transactions from raw operations (without the SDK) needs
  investigation. This is the hardest part of the "no SDK wrapping" decision.
- **WASM proving in browser**: The `WasmProver` exists in the SDK but its
  memory requirements and browser compatibility need testing.
