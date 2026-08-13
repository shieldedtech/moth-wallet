// Public surface of the wallet daemon module.
// L1 (filesystem perms) lives in server.ts; L3 (per-op confirmation) is the
// host application's responsibility — it composes its own modal-driven
// handlers and registers them with startDaemon().

export {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  DaemonProtocolError,
  encodeFrame,
  FrameDecoder,
} from './protocol.js';

export type {Frame, RequestFrame, ResponseFrame, RpcErrorCode} from './protocol.js';

export {startDaemon} from './server.js';
export type {DaemonHandle, DaemonOptions, RpcHandler, ConnectionContext, DaemonBind, AuthHandler, AuthResult, Scope} from './server.js';

export {ApiKeyStore} from './api-keys.js';
export type {ApiKeyRecord, ApiKeyGenerated, ApiKeyAuthResult} from './api-keys.js';

export {connectDaemon, connectDaemonTcp, connectDaemonBind} from './client.js';
export type {DaemonClient, ConnectDaemonOptions} from './client.js';

export {ConfirmationQueue} from './confirmation-queue.js';
export type {ConfirmationRequest, ConfirmationQueueOptions} from './confirmation-queue.js';

// Shared RPC handler factory + wire types + parsers. Both the TUI
// host and the headless serve mode build their handler map by
// calling buildWalletHandlers(deps) with the same dependency bundle.
export {buildWalletHandlers} from './wallet-handlers.js';
export type {WalletHandlerDeps} from './wallet-handlers.js';

export {AuditLog} from './audit-log.js';
export type {
  AuditEntry,
  AuditRpcEntry,
  AuditLifecycleEntry,
  AuditDecision,
  AuditLogOptions,
} from './audit-log.js';
export {
  parseSubmitTransactionParams,
  parseTransferTokensParams,
  parseCallCircuitParams,
  parseDeployContractParams,
  parseDustRegisterParams,
  parseDustDeregisterParams,
  parseInsertVerifierKeyParams,
  parseInsertVerifierKeysBatchParams,
  shortenHex,
  shortenAddress,
} from './wallet-rpc-parsers.js';
export type {
  DaemonGetStateResult,
  DaemonSubmitTransactionParams, DaemonSubmitTransactionResult,
  DaemonTransferTokensParams, DaemonTransferTokensResult,
  DaemonCallCircuitParams, DaemonCallCircuitResult,
  DaemonDeployContractParams, DaemonDeployContractResult,
  DaemonDustRegisterParams, DaemonDustRegisterResult,
  DaemonDustDeregisterParams, DaemonDustDeregisterResult,
  DaemonInsertVerifierKeyParams, DaemonInsertVerifierKeyResult,
  DaemonInsertVerifierKeysBatchParams, DaemonInsertVerifierKeysBatchResult,
} from './wallet-rpc-types.js';

import {join} from 'node:path';
import {homedir} from 'node:os';

/**
 * Canonical socket path for a (network, wallet) pair. Sits inside the same
 * `~/.moth/sync/<network>/` directory tree that the wallet sync cache uses,
 * so the L1 0700 directory perms protect both atomically.
 */
export function daemonSocketPath(networkId: string, walletName: string): string {
  return join(homedir(), '.moth', 'sync', networkId, `${walletName}.sock`);
}
