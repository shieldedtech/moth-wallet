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
  /**
   * Signature algorithm for the unshielded identity. Ledger v9 only — v8 has no
   * ECDSA. Fixed at creation: it selects the address, and DUST must be
   * re-registered if it changes.
   */
  signatureKind?: 'schnorr' | 'ecdsa';
  }): { info: WalletInfo; mnemonic: string };
  'os/walletImport'(data: {
    name: string;
    mnemonic: string;
    passphrase: string;
    network: string;
  }): WalletInfo;
  'os/walletRemove'(data: { name: string; network: string }): void;
  'os/walletSetActive'(data: { name: string; network: string }): void;
  /** Set or clear (empty string) a wallet's display label. */
  'os/walletSetLabel'(data: { name: string; label: string; network: string }): void;
  /** Decrypt and return a wallet's backup secret (mnemonic, or hex seed for
   *  hex-imported wallets). Rejects on a wrong passphrase. */
  'os/walletExportPhrase'(data: { name: string; passphrase: string; network: string }): {
    kind: 'mnemonic' | 'seed';
    value: string;
  };
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
  }): { txHex: string };

  /** Build a swap intent (`makeIntent`); returns the unproven, unbound tx hex. */
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
    /** Selects the signing key; the host reads the wallet's kind from it. */
    walletName: string;
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
