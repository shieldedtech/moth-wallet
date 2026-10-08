// Dedicated messaging channel between the background service worker and the
// offscreen document. Kept separate (own namespace) from the UI protocol so
// the two never cross-handle each other's messages.
//
// Why an offscreen document at all: `@midnight-ntwrk/ledger-v8` initializes its
// WASM with a top-level `await`, which a Chrome MV3 service worker cannot have
// in its module graph (registration fails). The offscreen document is a normal
// extension page with no such restriction, so all WASM/sync/tx work lives there
// and the SW stays a thin router.
//
// IMPORTANT: this module must stay WASM-free — it is imported by the SW. Only
// types cross from `moth-browser`; values (bigints/binary) travel as tagged JSON
// strings and balances as the serialized string produced by `serializeBalances`.

import { defineExtensionMessaging } from '@webext-core/messaging';
import type { WalletInfo, TxStage, NetworkConfig, SignEncoding, SignedMessage } from '@shieldedtech/moth-browser';
import type { HistoryEntry } from '@midnight-ntwrk/dapp-connector-api';
import type { RelayState } from './relay-socket';
import type { DustNotYet } from '../messaging/protocol';
import type { CardanoNetworkConfig } from '@shieldedtech/moth-wallet/cardano/network';
import type { CardanoAddressesResult, CardanoStatusResult } from './cardano-host';
import type { CardanoAccountList } from '@shieldedtech/moth-wallet/cardano/accounts';

/**
 * Everything a CIP-30 method can return, across all of them.
 *
 * Spelled out rather than `unknown`: the protocol map is a mapped type, and one
 * `unknown` member widens the inference for every other method in it.
 */
export type Cip30Result =
  | number
  | string
  | string[]
  | null
  | { signature: string; key: string }
  | ReadonlyArray<{ readonly cip: number }>;

export type { RelayState };

/** A transfer output, with the bigint amount carried as a decimal string. */
export interface TransferRequestDTO {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  amount: string;
  to: string;
}

/** A swap-intent input the wallet offers (spent); amount as a decimal string. */
export interface SwapInputDTO {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  amount: string;
}

/** One token amount a dApp transaction moves in or out of the wallet; amount as a decimal string. */
export interface TxTokenAmountDTO {
  kind: 'shielded' | 'unshielded' | 'dust';
  /** Raw token type hex; empty for DUST. */
  tokenId: string;
  /** Always positive; direction is the list it sits in. */
  amount: string;
}

/**
 * What balancing a dApp-supplied transaction costs the wallet, read off the
 * transaction before the user approves it (core sync/tx-summary.ts). Fees are
 * not part of it — they are only known once the wallet has balanced and proven
 * its own segment, and are always paid in DUST.
 */
export interface TxSummaryDTO {
  /** What the wallet must supply — the tokens that leave it. */
  spends: TxTokenAmountDTO[];
  /** Surplus the wallet collects back as change. */
  receives: TxTokenAmountDTO[];
  /** Contract calls, deploys and maintenance updates in the transaction. */
  contractActions: number;
}

/** Contract circuit material supplied by a connected dApp for one proof call. */
export interface ProvingKeyMaterialDTO {
  zkir: Uint8Array;
  proverKey: Uint8Array;
  verifierKey: Uint8Array;
}

export interface ProvingProviderCheckPayload {
  serializedPreimage: Uint8Array;
  keyLocation: string;
  keyMaterial: ProvingKeyMaterialDTO;
}

export interface ProvingProviderProvePayload extends ProvingProviderCheckPayload {
  overwriteBindingInput?: bigint;
}

/** Result of unlocking a keystore — the decrypted seed plus derived addresses
 *  and the shielded public keys (hex) the dApp connector exposes. */
export interface UnlockedWallet {
  name: string;
  /** User-chosen display label; `name` remains the immutable storage key. */
  label?: string;
  /** Network this wallet lives on (per-wallet; accounts can differ). */
  network: string;
  seedHex: string;
  address: string;
  addresses: WalletInfo['addresses'];
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
}

// Keys are prefixed `os/` so they never collide with the UI protocol
// (protocol.ts) — both live on the same chrome.runtime message channel, and
// @webext-core dispatches purely by key.
export interface OffscreenProtocol {
  // --- SW → offscreen (handled in the offscreen document) ---
  /** Resolves once the offscreen document's handlers are registered. */
  'os/ping'(): true;

  'os/walletList'(data: { network: string }): WalletInfo[];
  'os/walletCreate'(data: {
    name: string;
    passphrase: string;
    network: string;
    birthday?: number;
    /** Persist this phrase instead of a fresh one (shown to the user first). */
    mnemonic?: string;
  }): { info: WalletInfo; mnemonic: string };
  /** Exactly one of mnemonic / seed is set; the host routes on which. */
  'os/walletImport'(data: {
    name: string;
    mnemonic?: string;
    seed?: string;
    passphrase: string;
    network: string;
  }): WalletInfo;
  'os/walletRemove'(data: { name: string; network: string }): void;
  'os/walletSetActive'(data: { name: string; network: string }): void;
  /** Set or clear (empty string) a wallet's display label. */
  'os/walletSetLabel'(data: { name: string; label: string; network: string }): void;
  /** Decrypt and return a wallet's backup secret (mnemonic, or hex seed for
   *  hex-imported wallets). Rejects on a wrong passphrase. */
  'os/walletExportPhrase'(data: {
    name: string;
    passphrase: string;
    network: string;
    as?: 'backup' | 'seed';
  }): {
    kind: 'mnemonic' | 'seed';
    value: string;
  };
  // Cardano / cNIGHT. The mnemonic travels with each call rather than being
  // cached offscreen: the offscreen document is torn down and recreated at
  // Chrome's discretion, so a cached copy would be neither reliably present nor
  // reliably gone. The background holds it in storage.session, which is.
  // Account management. Storage-only; no key material crosses except the
  // phrase being imported and the passphrase that encrypts it.
  'os/cardanoAccountList'(data: { network: string; walletName: string }): CardanoAccountList;
  'os/cardanoAccountAdd'(data: {
    network: string;
    walletName: string;
    label?: string;
  }): CardanoAccountList;
  'os/cardanoAccountImport'(data: {
    network: string;
    walletName: string;
    mnemonic: string;
    passphrase: string;
    label?: string;
  }): { list: CardanoAccountList; id: string };
  'os/cardanoAccountSelect'(data: {
    network: string;
    walletName: string;
    id: string;
  }): CardanoAccountList;
  'os/cardanoAccountRemove'(data: {
    network: string;
    walletName: string;
    id: string;
  }): CardanoAccountList;
  'os/cardanoAccountRename'(data: {
    network: string;
    walletName: string;
    id: string;
    label: string;
  }): CardanoAccountList;
  'os/cardanoImportedPhrases'(data: {
    network: string;
    walletName: string;
    passphrase: string;
  }): Record<string, string>;

  'os/cardanoResolveReceiver'(data: { input: string }): { dustAddressBytes: string };
  'os/cardanoReceiverAccounts'(data: { network: string }): Array<{
    name: string;
    label: string;
    shieldedAddress: string;
    /** bech32m, for display. */
    dustAddress: string;
    /** Serialized DUST address — what a registration datum records. */
    dustAddressBytes: string;
  }>;
  'os/cardanoAddresses'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    accountIndex?: number;
  }): CardanoAddressesResult;
  'os/cardanoStatus'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    indexerUrl: string;
    accountIndex?: number;
  }): CardanoStatusResult;
  'os/cardanoRegister'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    receiver: string;
    accountIndex?: number;
  }): { txHash: string };
  'os/cardanoDeregister'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    accountIndex?: number;
  }): { txHash: string; cleared: number };
  'os/cardanoCip30'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    method: string;
    params: unknown[];
    accountIndex?: number;
  }): Cip30Result;
  'os/cardanoSend'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    request: { to: string; lovelace: string; cnight: string };
    accountIndex?: number;
  }): { txHash: string };
  'os/cardanoUpdate'(data: {
    mnemonic: string;
    config: CardanoNetworkConfig;
    receiver: string;
    accountIndex?: number;
  }): { txHash: string };

  /** Stop/reset one wallet's network-scoped state, move its metadata, and
   *  return the public addresses derived from the already-unlocked seed. */
  'os/walletSetNetwork'(data: {
    name: string;
    fromNetwork: string;
    network: string;
    seedHex: string;
    /** Chain tip of the network being moved to; recorded as the wallet's
     *  first-existence height there, on first arrival only. */
    birthday?: number;
  }): { address: string; addresses: WalletInfo['addresses'] };
  'os/walletUnlock'(data: { name: string; passphrase: string; network: string }): UnlockedWallet;

  /** Start (or resume) the sync engine. Balance/message updates stream back
   *  as `os/eventBalances`/`os/eventSyncMessage`. Resolves once started. */
  'os/syncEnsure'(data: { seedHex: string; walletName: string; network: NetworkConfig }): void;
  'os/syncStop'(): void;
  /** Clear persisted sync state after the running engine has stopped. */
  'os/syncCacheClear'(data: { walletName: string; networkIds: string[] }): void;
  /** Forget everything cached for this account on this network and start over:
   *  the account's sync state, its pending submissions, and the network's
   *  pre-seed reference — store and in-process memo. For a local chain restarted
   *  from genesis, where all of it describes a chain that no longer exists.
   *  Stops the engine first; the caller restarts it. */
  'os/syncCacheReset'(data: { walletName: string; network: NetworkConfig }): void;

  /** Ensure sync, wait for a synced snapshot, and return serialized balances. */
  'os/balancesGet'(data: { seedHex: string; walletName: string; network: NetworkConfig }): string;

  'os/sendTokens'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    requests: TransferRequestDTO[];
  }): { txHash: string };

  /** Estimate the complete DUST fee for the batch, including the balancing transaction. */
  'os/estimateTransferFee'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    requests: TransferRequestDTO[];
  }): { /** Raw SPECK as a decimal string. */ fee: string };

  /** Register the wallet's unshielded NIGHT for DUST generation. Stage updates
   *  stream back as `os/eventTxStage`. `txHash` is null when nothing needed
   *  registering (all NIGHT already registered). `dustAddress` optionally
   *  directs the generated DUST elsewhere (defaults to this wallet's own). */
  'os/registerDust'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    dustAddress?: string;
  }): { txHash: string | null; notYet?: DustNotYet };

  /** Deregister all registered NIGHT from DUST generation. Stage updates
   *  stream back as `os/eventTxStage`. */
  'os/deregisterDust'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
  }): { txHash: string };

  /** Build the pre-seed reference for a network to chain tip so later accounts
   *  skip the chain walk. Needs no wallet keys. Runs for tens of minutes and
   *  resumes if interrupted; `started` reports whether it reached tip this time. */
  'os/preseedWarm'(data: { network: NetworkConfig }): { started: boolean };

  /** Whether this network's pre-seed reference is ready, plus live build progress
   *  (dust events applied / total) so an hour-long job can be shown honestly. */
  'os/preseedStatus'(data: { network: NetworkConfig }): {
    ready: boolean;
    height: number | null;
    bundled: boolean;
    building: boolean;
    applied: number;
    total: number;
  };
  /** Evict the dust sync cache and restart sync so the dust sub-wallet rescans.
   *  Spends nothing. `started` is false when a transaction was in flight. */
  'os/dustRebuild'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
  }): { started: boolean };

  /** Request counts for the offscreen context, grouped by host — how many calls
   *  the wallet is making to the node and indexer, and how fast. */
  'os/nightCoins'(data: { seedHex: string; walletName: string; network: NetworkConfig }): import('../messaging/protocol').NightCoinRow[];
  'os/requestStats'(): import('./request-meter').MeterSnapshot;
  'os/requestStatsReset'(): void;

  /** Build + prove a transfer (dApp connector `makeTransfer`); returns hex. */
  'os/transferBuild'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    requests: TransferRequestDTO[];
    payFees: boolean;
  }): { txHex: string };

  /** Deserialize + submit an already-proven transaction (`submitTransaction`). */
  'os/transferSubmit'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    txHex: string;
  }): void;

  /** Balance + prove a dApp-supplied transaction (`balance{Sealed,Unsealed}Transaction`).
   *  `sealed` picks the input binding stage; returns the submit-ready hex. */
  'os/balanceTransaction'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    txHex: string;
    sealed: boolean;
    payFees: boolean;
  }): { txHex: string };

  /** Read what a dApp-supplied transaction would take from (and return to) the
   *  wallet once balanced, for the approval prompt. Needs no keys and no sync.
   *  `sealed` selects the deserialization stage, exactly as os/balanceTransaction does. */
  'os/txSummary'(data: { network: NetworkConfig; txHex: string; sealed: boolean }): TxSummaryDTO;

  /** Build, prove and seal a swap intent (`makeIntent`); returns hex. */
  'os/makeIntent'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    inputs: SwapInputDTO[];
    outputs: TransferRequestDTO[];
    payFees: boolean;
  }): { txHex: string };

  /** Applied transaction history (dApp connector `getTxHistory`), newest first,
   *  paginated. HistoryEntry is bigint-free, so it crosses the bus as-is. */
  'os/txHistoryGet'(data: {
    seedHex: string;
    walletName: string;
    network: NetworkConfig;
    pageNumber: number;
    pageSize: number;
  }): HistoryEntry[];

  /** The panel's activity feed (on-chain history + locally-submitted pending
   *  transactions), newest first, as the string produced by serializeActivity
   *  (ActivityEntry carries bigints, so it can't cross the bus raw). */
  'os/activityGet'(data: { seedHex: string; walletName: string; network: NetworkConfig }): string;

  /** Sign a message with the unshielded key (dApp connector `signData`). */
  'os/signData'(data: {
    seedHex: string;
    network: NetworkConfig;
    data: string;
    encoding: SignEncoding;
  }): SignedMessage;

  /** Derive a deterministic per-(origin, domain) 32-byte app secret from the
   *  seed (dApp connector extension `deriveAppSecret`). Origin is supplied by
   *  the background from the connection session, never by the DApp. */
  'os/deriveAppSecret'(data: {
    seedHex: string;
    origin: string;
    domain: string;
  }): Promise<{ secret: string }>;

  /** Low-level connector ProvingProvider operations. */
  'os/provingProviderCheck'(data: {
    network: NetworkConfig;
    /** Tagged JSON: Chrome runtime messaging does not clone binary/bigint. */
    payloadJson: string;
  }): string;
  'os/provingProviderProve'(data: {
    network: NetworkConfig;
    /** Tagged JSON: Chrome runtime messaging does not clone binary/bigint. */
    payloadJson: string;
  }): string;

  /** Clear the relay backoff so the next dial reaches the wire immediately
   *  ("Retry now"). Returns the state as of that reset. */
  'os/relayRetry'(): RelayState;

  // --- offscreen → SW (handled in the service worker) ---
  'os/eventBalances'(data: string): void;
  'os/eventSyncMessage'(message: string): void;
  'os/eventTxStage'(stage: TxStage): void;
  /** Node relay reachability, pushed whenever it changes. */
  'os/eventRelayState'(state: RelayState): void;
}

export const { sendMessage: offscreenSend, onMessage: offscreenOn } =
  defineExtensionMessaging<OffscreenProtocol>();
