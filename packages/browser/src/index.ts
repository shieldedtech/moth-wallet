export { IndexedDbStorageAdapter } from './adapters/idb-storage.js';
export { IdbSyncStateStore } from './adapters/idb-sync-store.js';

// Re-export core types and classes.
// IMPORTANT: import from core subpaths, never the barrel — the barrel exports
// Node-only modules (fs storage, batch transfer, contract tooling) that break
// browser bundles.
export type {
  WalletInfo,
  UnlockedWallet,
  DerivedKeys,
  SyncState,
  NetworkConfig,
  NetworkEndpoints,
  ProverConfig,
  TransactionResult,
} from '@shieldedtech/moth-wallet/types/index';
export type { StorageAdapter } from '@shieldedtech/moth-wallet/storage/adapter';
export type {
  SyncStateStore,
} from '@shieldedtech/moth-wallet/sync/sync-store';
export type {
  WalletSyncOptions,
  BatchUpdatesOptions,
  SyncedWallet,
  WalletBalances,
} from '@shieldedtech/moth-wallet/sync/wallet-sync';
export type {
  SendRequest,
  TxStage,
  FinalizedTransaction,
} from '@shieldedtech/moth-wallet/sync/operations';

export {
  warmEmptyRefCache,
  preseedReferenceStatus,
  type WarmProgress,
} from '@shieldedtech/moth-wallet/sync/preseed';
export { WalletManager } from '@shieldedtech/moth-wallet/wallet/manager';
export { deriveShieldedPublicKeys } from '@shieldedtech/moth-wallet/wallet/address';
export { signMessage, signedMessageBytes } from '@shieldedtech/moth-wallet/wallet/sign-message';
export { deriveAppSecret } from '@shieldedtech/moth-wallet/wallet/app-secret';
export type { SignEncoding, SignedMessage } from '@shieldedtech/moth-wallet/wallet/sign-message';
export { IndexerClient } from '@shieldedtech/moth-wallet/network/indexer-client';
export { ProofClient } from '@shieldedtech/moth-wallet/proof/client';
export { WalletError, NetworkError, ProofError } from '@shieldedtech/moth-wallet/types/errors';
export { ExitCode } from '@shieldedtech/moth-wallet/types/exit-codes';
export {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  SUPPORTED_NETWORKS,
  serverProver,
  resolveProverConfig,
  isProverConfig,
  proverConfigsEqual,
  describeProver,
} from '@shieldedtech/moth-wallet/types/network';
export {
  createProvingProvider,
  createProofProvider,
  createWalletProvingService,
  ensureProverReady,
} from '@shieldedtech/moth-wallet/proof/provider';
export {
  startWalletSync,
  clearSyncCache,
  clearDustSyncCache,
  clearShieldedSyncCache,
  clearSyncCacheParts,
  EMPTY_COINS,
} from '@shieldedtech/moth-wallet/sync/wallet-sync';
export {
  markShieldedSpent,
  isShieldedSpent,
  shieldedNullifiersOf,
} from '@shieldedtech/moth-wallet/sync/spent-shielded';
export {
  deriveActivity,
  deriveActivityEntry,
  sortActivity,
} from '@shieldedtech/moth-wallet/sync/activity';
export type {
  ActivityEntry,
  ActivityDelta,
  ActivityKind,
  ActivityStatus,
} from '@shieldedtech/moth-wallet/sync/activity';
export { formatNight, NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
export {
  sendTokens,
  buildTransferTransaction,
  estimateTransferFee,
  submitFinalizedTransaction,
  balanceTransaction,
  buildSwapIntent,
  designateForDust,
  estimateDustRegistration,
  DustRegistrationNotYetError,
  dedesignateFromDust,
  deriveWalletKeys,
} from '@shieldedtech/moth-wallet/sync/operations';
export type { SwapInput, WalletKeys } from '@shieldedtech/moth-wallet/sync/operations';

import {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  resolveProverConfig,
  serverProver,
  type NetworkConfig,
  type ProverConfig,
} from '@shieldedtech/moth-wallet/types/network';
import { IndexerClient } from '@shieldedtech/moth-wallet/network/indexer-client';
import { WalletManager } from '@shieldedtech/moth-wallet/wallet/manager';
import { IndexedDbStorageAdapter } from './adapters/idb-storage.js';

export interface MothBrowserConfig {
  /** Indexer GraphQL URL. Overrides the network default. */
  indexerUrl?: string;
  /** Node WebSocket URL. Overrides the network default. */
  nodeUrl?: string;
  /** Proving modality. Overrides the network default. */
  prover?: ProverConfig;
  /** @deprecated Use `prover: { type: 'server', url }`. */
  proofServerUrl?: string;
  /** Network ID (default: mainnet) */
  network?: string;
}

/**
 * Create a configured Moth browser instance with custom endpoint overrides.
 *
 * ```ts
 * const moth = createMothBrowser({
 *   indexerUrl: 'https://indexer.preview.midnight.network',
 *   network: 'preview',
 * });
 * const wallets = moth.wallets;
 * const indexer = moth.indexer;
 * ```
 */
export function createMothBrowser(config: MothBrowserConfig = {}) {
  const networkId = canonicalNetworkId(config.network ?? 'mainnet');

  const base = DEFAULT_NETWORKS[networkId] ?? {
    id: networkId,
    nodeUrl: 'ws://localhost:9944',
    // The GraphQL path is part of the endpoint, not decoration: the indexer
    // client posts queries to it, and the bare origin is not a GraphQL endpoint.
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  };

  const resolvedConfig: NetworkConfig = {
    id: networkId,
    indexerUrl: config.indexerUrl ?? base.indexerUrl,
    nodeUrl: config.nodeUrl ?? base.nodeUrl,
    prover:
      config.prover ??
      (config.proofServerUrl ? serverProver(config.proofServerUrl) : resolveProverConfig(base)),
  };

  const storage = new IndexedDbStorageAdapter();
  const wallets = new WalletManager(storage);
  const indexer = new IndexerClient(resolvedConfig.indexerUrl);

  return {
    wallets,
    indexer,
    config: resolvedConfig,
    storage,
  };
}
