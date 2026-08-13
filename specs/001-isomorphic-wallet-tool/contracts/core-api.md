> ⚠️ **This spec is superseded.** It predates the wallet daemon work
> landed on `feat/tui-daemon`. The current architecture lives at
> [`docs/spec/wallet-service/`](../../docs/spec/wallet-service/) and
> the operational reference at
> [`docs/spec/wallet-service/COMMANDS.md`](../../docs/spec/wallet-service/COMMANDS.md).
> Treat this file as historical context, not current truth.
# Core Library Public API Contract

**Date**: 2026-05-01

## Package: `@moth/core`

The isomorphic core library. Zero platform-specific imports. All I/O goes
through injected adapters.

### StorageAdapter Interface

```typescript
interface StorageAdapter {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}
```

### WalletManager

```typescript
interface WalletManager {
  generate(name: string, passphrase: string, network?: string): Promise<WalletInfo & { mnemonic: string }>;
  import(name: string, mnemonic: string, passphrase: string, network?: string): Promise<WalletInfo>;
  importFromSeed(name: string, hexSeed: string, passphrase: string, network?: string): Promise<WalletInfo>;
  unlock(name: string, passphrase: string): Promise<UnlockedWallet>;
  lock(wallet: UnlockedWallet): void;
  remove(name: string): Promise<void>;
  list(): Promise<WalletInfo[]>;
  getActive(): Promise<string | null>;
  setActive(name: string): Promise<void>;
}
```

### UnlockedWallet

```typescript
interface UnlockedWallet {
  readonly name: string;
  readonly address: string;
  readonly keys: DerivedKeys;  // transient, zeroed on lock()
  lock(): void;
}
```

### NetworkClient

```typescript
interface NetworkClient {
  connect(config: NetworkConfig): Promise<void>;
  disconnect(): Promise<void>;
  submitTransaction(tx: Uint8Array): AsyncIterable<SubmissionEvent>;
  getBlockHeight(): Promise<number>;
  getGenesisHash(): Promise<string>;
  isConnected(): boolean;
}
```

### IndexerClient

```typescript
interface IndexerClient {
  connect(url: URL, viewingKey: string): Promise<string>;  // returns sessionId
  disconnect(sessionId: string): Promise<void>;
  getBlock(offset?: BlockOffset): Promise<Block | null>;
  getTransactions(offset: TransactionOffset): Promise<Transaction[]>;
  getContractAction(address: string, offset?: ContractActionOffset): Promise<ContractAction | null>;
  getDustStatus(rewardAddresses: string[]): Promise<DustGenerationStatus[]>;
  subscribeBlocks(offset?: BlockOffset): AsyncIterable<Block>;
  subscribeContractActions(address: string, offset?: BlockOffset): AsyncIterable<ContractAction>;
  subscribeShieldedTransactions(sessionId: string, index?: number): AsyncIterable<ShieldedTransactionsEvent>;
  subscribeUnshieldedTransactions(address: string, txId?: number): AsyncIterable<UnshieldedTransactionsEvent>;
}
```

### ProofClient

```typescript
interface ProofClient {
  healthCheck(): Promise<ProofServerStatus>;
  prove(unprovenTx: Uint8Array): Promise<Uint8Array>;
  check(preimage: Uint8Array): Promise<(bigint | undefined)[]>;
}

interface ProofServerStatus {
  healthy: boolean;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}
```

### TransactionBuilder

```typescript
interface TransactionBuilder {
  buildTransfer(params: TransferParams): Promise<Uint8Array>;
  buildDeploy(params: DeployParams): Promise<Uint8Array>;
  buildCircuitCall(params: CircuitCallParams): Promise<Uint8Array>;
  buildDustRegister(params: DustRegisterParams): Promise<Uint8Array>;
  buildDustDeregister(params: DustDeregisterParams): Promise<Uint8Array>;
  buildMint(params: MintParams): Promise<Uint8Array>;
}
```

### SyncEngine

```typescript
interface SyncEngine {
  start(wallet: UnlockedWallet, network: NetworkConfig): Promise<void>;
  stop(): Promise<void>;
  waitForTip(timeoutMs: number): Promise<SyncState>;
  getState(): SyncState;
  onProgress(callback: (state: SyncState) => void): () => void;
}
```

### Factory Function

```typescript
function createWalletCore(options: {
  storage: StorageAdapter;
}): {
  wallets: WalletManager;
  sync: SyncEngine;
  transactions: TransactionBuilder;
  createNetworkClient(config: NetworkConfig): NetworkClient;
  createIndexerClient(url: URL): IndexerClient;
  createProofClient(url: URL): ProofClient;
};
```

## Package: `@moth/cli`

CLI shell. Depends on `@moth/core`. Provides:
- Filesystem `StorageAdapter` implementation
- Terminal passphrase prompting
- oclif command definitions
- Human-readable and JSON output formatters
- `moth` binary entry point

## Package: `@moth/browser`

Browser adapter. Depends on `@moth/core`. Provides:
- IndexedDB `StorageAdapter` implementation
- Web Crypto-based passphrase handling
- ESM bundle for `<script type="module">` or bundler import

## Package: `@moth/tui`

Interactive terminal UI. Depends on `@moth/core`. Provides:
- React/Ink dashboard screens
- Real-time sync progress display
- Interactive transfer, deploy, and DUST management flows
