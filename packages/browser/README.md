# @shieldedtech/moth-browser

Browser-compatible wallet library for the [Midnight Network](https://midnight.network). A thin
adapter around [`@shieldedtech/moth-wallet`](https://www.npmjs.com/package/@shieldedtech/moth-wallet)
that swaps the filesystem keystore for **IndexedDB** so the core wallet logic runs in the browser.

Part of [Moth](https://github.com/shieldedtech/moth-wallet).

> **Experimental — use at your own risk.** This is unaudited software provided AS-IS with no
> warranty, for development and testing only. Mainnet is rejected; do not use it with real funds.

## Install

```bash
npm install @shieldedtech/moth-browser
```

## Usage

```typescript
import { createMothBrowser } from '@shieldedtech/moth-browser';

// Configure with custom endpoints (IndexedDB-backed storage is wired up for you).
const moth = createMothBrowser({
  indexerUrl: 'https://indexer.preview.midnight.network',
  network: 'preview',
  prover: { type: 'wasm' },
});

// Generate a wallet
const info = await moth.wallets.generate('my-wallet', 'passphrase');
console.log(info.addresses.nightExternal.bech32m.preview);

// Query contract state
const state = await moth.indexer.getContractAction('0x...');

// Or use individual components with custom URLs
import { IndexerClient, ProofClient } from '@shieldedtech/moth-browser';
const indexer = new IndexerClient('https://my-indexer.example.com');
const prover = new ProofClient('http://localhost:6300');
```

`createMothBrowser(config)` returns `{ wallets, indexer, config, storage }`. The package also
re-exports `WalletManager`, `IndexerClient`, `ProofClient`, the error types, and `DEFAULT_NETWORKS`
from the core library, plus the browser-only `IndexedDbStorageAdapter`.

Set `prover` to `{ type: 'wasm' }` for local proving, or to
`{ type: 'server', url: 'https://prover.example.com' }` for a remote proof
server. The legacy `proofServerUrl` option remains accepted for compatibility.

## Documentation

See the [project README](https://github.com/shieldedtech/moth-wallet#readme) for architecture,
the security model, and network configuration.

## License

Apache-2.0 — see [LICENSE](https://github.com/shieldedtech/moth-wallet/blob/main/LICENSE).
