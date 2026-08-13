# Connector Lab

A standalone mock dapp for testing a wallet's implementation of
`@midnight-ntwrk/dapp-connector-api` 4.0.1. It discovers providers through
`window.midnight` and does not import code, components, or styles from the Moth
extension. The UI mirrors the extension's design language (the Milk/Ink/Moonlime
palette, Bricolage Grotesque and Instrument Sans) recreated in plain CSS, so the
two stay visually consistent without sharing code.

## Run locally

Start the extension and mock dapp in separate terminals from the repository
root:

```bash
yarn workspace @shieldedtech/moth-extension dev
yarn dev:mock-dapp
```

Open `http://127.0.0.1:5173` in the browser profile where the extension is
loaded. The fixed origin keeps wallet permissions stable between runs. The page
retries provider discovery briefly during startup; use
**Refresh** if the extension is enabled after the page has loaded.

Choose the same network that the wallet is configured to use, then connect.
Connection, signing, transfer, intent, and balancing requests can open wallet
approval UI.

> Transaction actions use the wallet's configured node and proving method. They
> are not simulated, so avoid mainnet or funded accounts during testing.

## API coverage

The workbench covers provider metadata and `connect`, plus every method on the
4.0.1 `ConnectedAPI`:

- connection status, configuration, balances, addresses, and paginated history;
- `hintUsage` and `signData`;
- `makeTransfer`, `makeIntent`, sealed/unsealed balancing, and submission;
- `getProvingProvider`; the dapp supplies circuit key material while the wallet
  executes `check` and `prove` with its selected server or WASM backend.

Transfer and intent results are copied into the shared transaction field so a
build → balance → submit flow can be tested without moving hex manually. The
request log preserves bigint values, durations, and connector `code`/`reason`
fields and can be copied as JSON.

The Balance or submit panel also includes a local Ledger v8 fixture generator.
It creates a proof-stage, unsealed preprod transaction with no inputs and one
1 NIGHT output to
`mn_addr_preprod1he0ty4u5vnmqdmvg85vgx9shxqh5snnvudszkr38ykqpkefu6xwsq30mjf`.
That deliberate 1 NIGHT deficit can be passed directly to
`balanceUnsealedTransaction`; the wallet supplies the input, change, and fees.

Resetting the local session only discards the page's `ConnectedAPI` reference;
it does not revoke the origin in the wallet.

## Build

```bash
yarn workspace @shieldedtech/moth-mock-dapp build
```
