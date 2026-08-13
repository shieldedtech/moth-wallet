# @shieldedtech/moth-wallet

The isomorphic core engine of [Moth](https://github.com/shieldedtech/moth-wallet), a wallet tool
for the [Midnight Network](https://midnight.network). This package contains all wallet logic with
zero platform-specific imports: HD key derivation, encrypted keystores, network/indexer/proving
providers, background sync, and transaction building (deploy, call, transfer, mint, DUST).

The `cli`, `browser`, and `tui` packages are thin platform shells around this core.

> **Experimental — use at your own risk.** This is unaudited software provided AS-IS with no
> warranty, for development and testing only. Do not use it with real funds on mainnet.

## Install

```bash
npm install @shieldedtech/moth-wallet
```

## Usage

```typescript
import { WalletManager, FilesystemStorageAdapter } from '@shieldedtech/moth-wallet';

// WalletManager persists encrypted keystores via a StorageAdapter
// (FilesystemStorageAdapter defaults to ~/.moth).
const wallets = new WalletManager(new FilesystemStorageAdapter());

// Generate a wallet — returns its info plus the freshly generated 24-word mnemonic.
const info = await wallets.generate('dev', 'passphrase', 'preview');
console.log(info.addresses.nightExternal.bech32m.preview);

// Unlock to derive keys for signing; lock() zeroes key material from memory.
const unlocked = await wallets.unlock('dev', 'passphrase');
// ... build and submit transactions ...
unlocked.lock();
```

Key entry points exported from the package root include `WalletManager`, `generateMnemonic24`,
`startWalletSync`, `sendTokens`, `deployContract`, `callCircuit`, `queryContractState`,
`loadContractArtifact`, `IndexerClient`, `JsonRpcNodeClient`, `ProofClient`,
`createProvingProvider`, `TransactionBuilder`, and `DEFAULT_NETWORKS`.

## Modules

| Area | What it covers |
| --- | --- |
| `wallet/` | HD derivation (BIP-44 `m/44'/2400'`), keystore encryption, mnemonics, balance |
| `network/` | JSON-RPC node client, GraphQL indexer client |
| `transaction/` | Transaction builder — deploy, call, transfer, mint, DUST |
| `proof/` | Selectable proof-server and local WASM providers |
| `sync/` | Background wallet sync with genesis-reset detection |
| `contract/` | Artifact/witness loading, args parsing, state queries, maintenance |
| `storage/` | `StorageAdapter` interface + filesystem implementation |

## Documentation

See the [project README](https://github.com/shieldedtech/moth-wallet#readme) for full
architecture, the security model, and end-to-end examples.

## License

Apache-2.0 — see [LICENSE](https://github.com/shieldedtech/moth-wallet/blob/main/LICENSE).
