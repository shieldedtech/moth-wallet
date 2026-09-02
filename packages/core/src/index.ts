// Types
export * from './types/index.js';
export type { NetworkConfig, NetworkEndpoints, ProverConfig, LedgerVersion } from './types/network.js';
export {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  resolveLedgerVersion,
  SUPPORTED_NETWORKS,
  validateNetworkUrl,
  validateNetworkConfig,
  serverProver,
  resolveProverConfig,
  isProverConfig,
  proverConfigsEqual,
  describeProver,
} from './types/network.js';

// Ledger seam (v8 / v9)
export {
  initLedger,
  ledger,
  ledgerFor,
  activeLedgerVersion,
  resetLedgerRegistry,
  type LedgerModule,
} from './ledger/index.js';
export {
  PROTOCOL_VERSION_V8,
  PROTOCOL_VERSION_V9,
  ledgerVersionForProtocol,
  assertLedgerForNetwork,
  verifyNetworkLedger,
  detectLedgerVersion,
  resetLedgerDetectionCache,
  type DetectedLedger,
} from './ledger/protocol-version.js';

// Wallet SDK seam (v8 / v9)
export {
  initSdk,
  sdk,
  sdkFor,
  activeSdkVersion,
  resetSdkRegistry,
  createKeystoreFor,
  type SdkModule,
} from './sdk/index.js';

// Wallet
export { WalletManager } from './wallet/manager.js';
export {
  NIGHT_DENOMINATION,
  DUST_DENOMINATION,
  formatBalance,
  formatDustBalance,
} from './wallet/balance-format.js';
export { generateMnemonic24, validateMnemonic, mnemonicToSeed, hexSeedToUint8Array } from './wallet/mnemonic.js';
export { Roles } from './wallet/address.js';
export { encryptKeystore, decryptKeystore, type EncryptedKeystore } from './wallet/keystore.js';
export {
  parseNightAmount,
  formatNightAmount,
  InvalidAmountError,
  STARS_PER_NIGHT,
  NIGHT_DECIMALS,
} from './wallet/night-amount.js';
export { deriveAllAddressesFromSeed, deriveRawKeys, deriveShieldedPublicKeys, decodeBech32mAddress } from './wallet/address.js';
export { signMessage, signedMessageBytes, type SignEncoding, type SignedMessage } from './wallet/sign-message.js';
export {
  signatureKindOf,
  unwrapSignatureValue,
  type SignatureKind,
  type TaggedOrBare,
} from './wallet/signature-encoding.js';
export { deriveAppSecret } from './wallet/app-secret.js';
export { loadBatchFile, executeBatchTransfer, batchExitCode, type BatchTransferEntry, type BatchTransferResult, type BatchTransferSummary } from './wallet/batch-transfer.js';

// Storage
export type { StorageAdapter } from './storage/adapter.js';
export { FilesystemStorageAdapter } from './storage/fs-adapter.js';

// Network
export { JsonRpcNodeClient, type NodeClient } from './network/node-client.js';
export { IndexerClient } from './network/indexer-client.js';
export type { Block, ContractAction, DustGenerationStatus, TransactionInfo } from './network/indexer-client.js';

// Proof
export { ProofClient, type ProofServerStatus } from './proof/client.js';
export {
  createProvingProvider,
  createProofProvider,
  createWalletProvingService,
  ensureProverReady,
} from './proof/provider.js';

// Sync
export {
  startWalletSync, formatNight, NIGHT_TOKEN_ID, clearSyncCache, clearDustSyncCache, resolveSyncStore,
  EMPTY_COINS, EMPTY_SUB_PROGRESS, type WalletSyncOptions,
  type WalletBalances, type SyncedWallet, type DustGeneration, type SyncProgress,
  type SubWalletSyncProgress, type SubWalletProgress, type WalletCoinDetails,
  type ShieldedCoinInfo, type UnshieldedCoinInfo, type DustCoinInfo,
} from './sync/wallet-sync.js';
export {
  // Union of both lines: main's build/estimate/submit + batch types the
  // extension imports, plus v8's derive-and-drop walletKeys write paths.
  sendTokens, sendTokensWithKeys, deriveWalletKeys,
  buildTransferTransaction, estimateTransferFee, submitFinalizedTransaction,
  designateForDust, designateForDustWithKeys, estimateDustRegistration,
  dedesignateFromDust, dedesignateFromDustWithKeys,
  listNightUtxos,
  type SendRequest, type TxStage, type NightUtxo, type FinalizedTransaction, type WalletKeys,
} from './sync/operations.js';
export {
  summarizeTransaction, summarizeConnectorTransaction, decodeConnectorTransaction,
  type TransactionSummary, type TxTokenAmount,
} from './sync/tx-summary.js';
export {
  InMemorySyncStateStore, syncStateKey, emptyRefStateKey, emptyRefMnemonicKey, emptyRefHeightKey,
  type SyncStateStore, type WalletPart,
} from './sync/sync-store.js';
export {
  deriveActivity, deriveActivityEntry, sortActivity,
  type ActivityEntry, type ActivityDelta, type ActivityKind, type ActivityStatus,
} from './sync/activity.js';
export {
  estimateRegistrationAffordability,
  describeWait,
  DustRegistrationNotYetError,
  type DustGenerationSlice,
  type DustRegistrationEstimate,
} from './sync/dust-registration-estimate.js';
export {
  readEventWitness,
  compareWitness,
  verifyCursorWitness,
  type CursorWitness,
  type WitnessStream,
  type WitnessVerdict,
} from './sync/cursor-witness.js';
export { ensureEmptyRefCache, warmEmptyRefCache, clearEmptyRefCache, refreshEmptyRefCache, preseedReferenceStatus, preSeedNewWallet, type WarmProgress } from './sync/preseed.js';

// Contract
export { loadContractArtifact, type ContractArtifact } from './contract/artifact-loader.js';
export { loadWitnessProvider, type WitnessProvider } from './contract/witness-loader.js';
export { deployContract, type DeployOptions } from './contract/deploy.js';
export { callCircuit, type CallOptions } from './contract/call.js';
export {
  insertVerifierKey, type InsertVerifierKeyOptions,
  insertVerifierKeys, type InsertVerifierKeysOptions,
  type BatchEntryResult, type BatchInsertResult,
} from './contract/maintenance.js';
export { queryContractState, type ContractState } from './contract/state.js';
export {
  deployFungibleToken,
  mintFungibleToken,
  FUNGIBLE_TOKEN_ARTIFACT_DIR,
  type DeployFungibleTokenOptions,
  type MintFungibleTokenOptions,
} from './contract/fungible-token.js';
export { parseArgs, toPositionalArgs } from './contract/args-parser.js';
export {
  resolveInitialPrivateState,
  type ResolveInitialPrivateStateOptions,
} from './contract/initial-private-state.js';

// Providers — bridge SDK interfaces with our infrastructure
export { createMidnightProvider } from './providers/midnight-provider.js';

// Daemon — opt-in Unix-socket RPC for sharing a live wallet between the TUI
// host and CLI clients. L1 perms enforced at the socket; L3 confirmation is
// the host's responsibility (see packages/tui).
export {
  startDaemon, connectDaemon, connectDaemonTcp, connectDaemonBind, daemonSocketPath,
  PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION,
  DaemonProtocolError, ConfirmationQueue,
  buildWalletHandlers,
  AuditLog,
  ApiKeyStore,
  parseSubmitTransactionParams, parseTransferTokensParams,
  parseCallCircuitParams, parseDeployContractParams,
  parseDustRegisterParams, parseDustDeregisterParams,
  parseInsertVerifierKeyParams, parseInsertVerifierKeysBatchParams,
  shortenHex, shortenAddress,
  type DaemonHandle, type DaemonOptions, type DaemonClient, type DaemonBind,
  type RpcHandler, type ConnectionContext, type RpcErrorCode,
  type AuthHandler, type AuthResult, type Scope,
  type ConfirmationRequest, type ConfirmationQueueOptions,
  type WalletHandlerDeps,
  type DaemonGetStateResult,
  type DaemonSubmitTransactionParams, type DaemonSubmitTransactionResult,
  type DaemonTransferTokensParams, type DaemonTransferTokensResult,
  type DaemonCallCircuitParams, type DaemonCallCircuitResult,
  type DaemonDeployContractParams, type DaemonDeployContractResult,
  type DaemonDustRegisterParams, type DaemonDustRegisterResult,
  type DaemonDustDeregisterParams, type DaemonDustDeregisterResult,
  type DaemonInsertVerifierKeyParams, type DaemonInsertVerifierKeyResult,
  type DaemonInsertVerifierKeysBatchParams, type DaemonInsertVerifierKeysBatchResult,
  type AuditEntry, type AuditRpcEntry, type AuditLifecycleEntry,
  type AuditDecision, type AuditLogOptions,
  type ApiKeyRecord, type ApiKeyGenerated, type ApiKeyAuthResult,
} from './daemon/index.js';
export { unshieldedSplit, describeReservation, type SpendableSplit } from './wallet/spendable.js';
