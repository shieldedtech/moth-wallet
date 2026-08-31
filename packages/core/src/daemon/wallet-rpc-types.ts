// Wire-format types for every wallet daemon verb. Lives in core so
// both the TUI host (packages/tui/src/hooks/useDaemonHost.ts) and the
// headless host (packages/cli/src/commands/daemon/serve.ts) — and any
// future client that imports the SDK — share one source of truth.
//
// All bigint fields cross the JSON boundary as decimal strings. All
// host-filesystem paths are resolved client-side before they hit the
// daemon — the daemon does its own resolvePath on receipt for the
// modal display, but treats the incoming string as authoritative.

import type {SyncProgress, TransactionResult} from '../index.js';

// ─────────────────────────────────────────────────────────────────────
// getState (read)
// ─────────────────────────────────────────────────────────────────────

export type DaemonGetStateResult = {
  readonly ready: boolean;
  readonly walletName?: string;
  readonly networkId?: string;
  readonly synced?: boolean;
  readonly syncProgress?: SyncProgress;
  readonly balances?: {
    readonly shielded: Record<string, string>;
    readonly unshielded: Record<string, string>;
    readonly dust: string;
  };
};

// ─────────────────────────────────────────────────────────────────────
// submitTransaction
// ─────────────────────────────────────────────────────────────────────

export type DaemonSubmitTransactionParams = {
  /** Hex-encoded FinalizedTransaction (output of tx.serialize()). */
  readonly hex: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonSubmitTransactionResult = {
  readonly txId: string;
};

// ─────────────────────────────────────────────────────────────────────
// balanceTransaction
// ─────────────────────────────────────────────────────────────────────

export type DaemonBalanceTransactionParams = {
  /** Hex-encoded transaction to balance (dApp connector flow: the wallet
   *  pays its fees and adds inputs/outputs to remove imbalances, then
   *  proves and signs). */
  readonly hex: string;
  /** Input stage: 'sealed' → Transaction<SignatureEnabled, Proof, Binding>;
   *  'unsealed' → …Proof, PreBinding; 'unproven' → …PreProof, PreBinding —
   *  the common dApp shape (dApps cannot prove; the wallet's finalize step
   *  generates the proofs via its proof server). */
  readonly stage: 'sealed' | 'unsealed' | 'unproven';
  /** Submit the balanced transaction too (default true). When false the
   *  balanced FinalizedTransaction is returned as hex instead. */
  readonly submit?: boolean;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonBalanceTransactionResult = {
  readonly submitted: boolean;
  /** Transaction id when submitted; null otherwise. */
  readonly txId: string | null;
  /** Hex-encoded balanced FinalizedTransaction when submit=false; null otherwise. */
  readonly finalizedHex: string | null;
};

// ─────────────────────────────────────────────────────────────────────
// transferTokens
// ─────────────────────────────────────────────────────────────────────

export type DaemonTransferTokensParams = {
  readonly type: 'shielded' | 'unshielded';
  /** 64-char hex token id. NIGHT is '0' * 64. */
  readonly tokenId: string;
  /** Raw decimal amount in the token's smallest unit. */
  readonly amount: string;
  readonly to: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonTransferTokensResult = {
  readonly txId: string;
};

// ─────────────────────────────────────────────────────────────────────
// callCircuit
// ─────────────────────────────────────────────────────────────────────

export type DaemonCallCircuitParams = {
  readonly contractAddress: string;
  readonly circuitName: string;
  /** Raw args string. Daemon parses via parseArgs (accepts JSON inline
   *  or '@file.json' from the daemon-host filesystem). */
  readonly args?: string;
  readonly artifactPath: string;
  readonly witnessesPath?: string;
  readonly projectDir?: string;
  readonly timeoutSec?: number;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonCallCircuitResult = {
  readonly txHash: string;
  readonly status: TransactionResult['status'];
  readonly blockHash: string | null;
  readonly blockHeight: number | null;
  readonly contractAddress: string | null;
  readonly fees: TransactionResult['fees'];
};

// ─────────────────────────────────────────────────────────────────────
// deployContract
// ─────────────────────────────────────────────────────────────────────

export type DaemonDeployContractParams = {
  readonly artifactPath: string;
  readonly witnessesPath?: string;
  readonly projectDir?: string;
  readonly timeoutSec?: number;
  /** Constructor arguments as JSON or @file.json (same convention as `deploy --args`). */
  readonly args?: string;
  /** Initial private state as JSON or @file.json (same convention as `deploy --private-state`). */
  readonly privateState?: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonDeployContractResult = {
  readonly txHash: string;
  readonly status: TransactionResult['status'];
  readonly blockHash: string | null;
  readonly blockHeight: number | null;
  readonly contractAddress: string | null;
  readonly fees: TransactionResult['fees'];
};

// ─────────────────────────────────────────────────────────────────────
// dustRegister / dustDeregister
// ─────────────────────────────────────────────────────────────────────

export type DaemonDustRegisterParams = {
  readonly receiver?: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonDustRegisterResult = {
  readonly txId: string | null;
  readonly registered: boolean;
};

export type DaemonDustDeregisterParams = {
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonDustDeregisterResult = {
  readonly txId: string;
};

// ─────────────────────────────────────────────────────────────────────
// insertVerifierKey / insertVerifierKeysBatch
// ─────────────────────────────────────────────────────────────────────

export type DaemonInsertVerifierKeyParams = {
  readonly contractAddress: string;
  readonly circuitId: string;
  readonly verifierKeyPath: string;
  readonly artifactPath: string;
  readonly projectDir?: string;
  readonly timeoutSec?: number;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonInsertVerifierKeyResult = {
  readonly txHash: string;
  readonly status: TransactionResult['status'];
  readonly blockHash: string | null;
  readonly blockHeight: number | null;
  readonly contractAddress: string | null;
  readonly fees: TransactionResult['fees'];
};

export type DaemonInsertVerifierKeysBatchParams = {
  readonly contractAddress: string;
  readonly entries: ReadonlyArray<{readonly circuitId: string; readonly verifierKeyPath: string}>;
  readonly artifactPath: string;
  readonly projectDir?: string;
  readonly skipExisting?: boolean;
  readonly timeoutSec?: number;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonInsertVerifierKeysBatchResult = {
  readonly contractAddress: string;
  readonly total: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly failed: number;
  readonly entries: ReadonlyArray<{
    readonly circuitId: string;
    readonly status: 'inserted' | 'skipped-existing' | 'failed';
    readonly txHash?: string;
    readonly blockHeight?: number | null;
    readonly error?: string;
  }>;
};
