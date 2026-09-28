export const WALLET_ID = 'moth';
export const WALLET_RDNS = 'io.shielded.moth';
export const WALLET_NAME = 'Moth Wallet';
/** Version of the @midnight-ntwrk/dapp-connector-api standard implemented. */
export const API_VERSION = '4.0.1';

/** The Moth mark, inlined so the page never fetches from the extension.
 *
 *  Kept in step with brand/icon-small.svg — the simplified variant, because this
 *  is what a dApp renders in a wallet-picker row, at about the size of a favicon.
 *  It previously carried a purple diagonal that matched nothing: not the old
 *  brand, and not the Moonlime palette in assets/globals.css. Hardcoded hexes
 *  rather than CSS variables on purpose: this string is handed to a page we do
 *  not control and must render without our stylesheet. */
export const WALLET_ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#1c1f36"/><g transform="translate(32 33) scale(1.06) translate(-32 -36)"><g id="w"><path d="M35 22 C 47 22, 57 30, 62 41 C 50 44, 39 43, 35 38 Z" fill="#aeeb6b"/><path d="M35 37 C 42 39, 48 44, 46 51 C 39 54, 34 48, 33 41 Z" fill="#aeeb6b"/></g><use href="#w" transform="translate(64 0) scale(-1 1)"/><ellipse cx="32" cy="37" rx="3.2" ry="11" fill="#aeeb6b"/></g></svg>',
  );

/** ConnectedAPI methods the MVP implements; everything else rejects with InternalError. */
export const IMPLEMENTED_METHODS = [
  'getShieldedBalances',
  'getUnshieldedBalances',
  'getDustBalance',
  'getShieldedAddresses',
  'getUnshieldedAddress',
  'getDustAddress',
  'makeTransfer',
  'submitTransaction',
  'getConfiguration',
  'getConnectionStatus',
  'getTxHistory',
  'signData',
  'balanceSealedTransaction',
  'balanceUnsealedTransaction',
  'makeIntent',
  'hintUsage',
  'getProvingProvider',
] as const;

export const NOT_IMPLEMENTED_METHODS = [] as const;

/** Non-standard wallet extension methods — NOT in @midnight-ntwrk/dapp-connector-api
 *  v4.0.1. Exposed on the injected API so DApps can call them (via a TS cast),
 *  and proposed upstream separately. See specs/003-derive-app-secret. */
export const EXTENSION_METHODS = [
  'deriveAppSecret',
  // Spendable shielded coin detail. A Compact circuit that takes a coin as an
  // argument needs a full QualifiedShieldedCoinInfo {nonce, type, value,
  // mt_index}, and a DApp cannot derive it: the connector API has no coin
  // enumeration, and the indexer's queryZSwapAndContractState returns a
  // CONTRACT-FILTERED Zswap state whose firstFree is 0, so it cannot yield a
  // global Merkle index. Only the wallet tracks the global commitment tree for
  // its own coins. Without this, every spend-a-user-coin contract pattern
  // (vaults, wrappers, escrow, DEX) is uncallable from the browser.
  // Non-standard pending an upstream connector-API addition.
  'getShieldedCoins',
] as const;

/** Private RPC calls used by the page-local ProvingProvider proxy. */
export const PROVING_PROVIDER_METHODS = [
  'provingProviderCheck',
  'provingProviderProve',
] as const;

export type ConnectorMethod =
  | 'connect'
  | (typeof IMPLEMENTED_METHODS)[number]
  | (typeof NOT_IMPLEMENTED_METHODS)[number]
  | (typeof EXTENSION_METHODS)[number]
  | (typeof PROVING_PROVIDER_METHODS)[number];
