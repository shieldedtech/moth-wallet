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

## Bundled contracts

`contracts/` holds the contracts moth deploys itself: `moth-ft`, the token issuer behind
`deployFungibleToken` and `mintFungibleToken` (shipped in the package), and `receive-unshielded`,
a test fixture (not shipped). Each has two builds of the same source:

| Directory | Compiler | Runtime | midnight-js 5 runs it as |
| --- | --- | --- | --- |
| `<name>/ledger8/managed` | compactc 0.31.1 | compact-runtime 0.16.0 | a ledger-8 contract: deployed before the v9 fork, callable on both sides |
| `<name>/ledger9/managed` | compactc 0.36.0 | compact-runtime 0.21.0 | a ledger-9 contract: deployed and called from the fork on |

A deploy takes the build for the era of the network's latest block (`bundledContractForDeploy`).
A call takes the build whose verifier keys the contract holds on chain (`bundledContractForAddress`),
since midnight-js refuses to attach any other.

This package depends on compact-runtime 0.21.0 under its own name, for the ledger-9 builds and
midnight-js, and on 0.16.0 under the alias `compact-runtime-ledger8`, the name midnight-js gives its
own ledger-8 copy. The ledger-8 modules import the alias: their first line, as compactc wrote it,
imports `@midnight-ntwrk/compact-runtime`, and is edited to `compact-runtime-ledger8` in both
`contract/index.js` and `contract/index.d.ts`. `tests/unit/contract/bundled.test.ts` checks this.

Leave the ledger-8 builds as they are: contracts deployed from them take calls only with these exact
verifier keys. To rebuild a ledger-9 build, run from the contract's directory, so that the source
map holds relative paths:

```bash
compact compile +0.36.0 moth-ft.compact ledger9/managed
```

## Documentation

See the [project README](https://github.com/shieldedtech/moth-wallet#readme) for full
architecture, the security model, and end-to-end examples.

## License

Apache-2.0 — see [LICENSE](https://github.com/shieldedtech/moth-wallet/blob/main/LICENSE).
