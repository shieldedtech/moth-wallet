// Wire-format types for every wallet daemon verb. Lives in core so
// both the TUI host (packages/tui/src/hooks/useDaemonHost.ts) and the
// headless host (packages/cli/src/commands/daemon/serve.ts) — and any
// future client that imports the SDK — share one source of truth.
//
// All bigint fields cross the JSON boundary as decimal strings. All
// host-filesystem paths are resolved client-side before they hit the
// daemon — the daemon does its own resolvePath on receipt for the
// modal display, but treats the incoming string as authoritative.

import type {SubWalletProgress, SyncProgress, TransactionResult} from '../index.js';

// ─────────────────────────────────────────────────────────────────────
// getState (read)
// ─────────────────────────────────────────────────────────────────────

export type DaemonShieldedCoinWire = {
  readonly value: string;
  readonly type: string;
};

export type DaemonUnshieldedCoinWire = {
  readonly value: string;
  readonly type: string;
  readonly registeredForDustGeneration: boolean;
  /** ISO-8601, or null when the SDK reported none. */
  readonly ctime: string | null;
};

/** One dust coin, as wallet-sync's DustCoinInfo crosses the wire. */
export type DaemonDustCoinWire = {
  /** SPECK generated so far. */
  readonly generatedNow: string;
  /** SPECK the coin can hold at most. */
  readonly maxCap: string;
  readonly maxCapReachedAt: string;
  /** ISO-8601 when the backing NIGHT was spent, else null. */
  readonly dtime: string | null;
  /** The backing NIGHT UTXO's initial nonce (hex) — matches the indexer's generation entry. */
  readonly backingNight: string | null;
  /** How many times this coin's chain has been spent. */
  readonly seq: number | null;
  /** SPECK at the coin's creation (its last spend). */
  readonly initialValue: string | null;
  readonly ctime: string | null;
};

export type DaemonDustGenerationWire = {
  readonly balance: string;
  readonly designated: string;
  readonly ratePerDay: string;
  readonly limit: string;
  readonly fillTime: string | null;
  readonly numUtxos: number;
  readonly registered: boolean;
  readonly registeredNight: string;
  readonly newestRegisteredAt: string | null;
};

/** wallet-sync's DustViewHealth on the wire (see sync/dust-view.ts). */
export type DaemonDustViewWire = {
  /** unchecked | complete | incomplete | unknown — only `incomplete` withholds dustSynced. */
  readonly status: 'unchecked' | 'complete' | 'incomplete' | 'unknown';
  readonly checkedAt: string | null;
  readonly verdictAt: string | null;
  readonly complete: boolean;
  readonly lastError: string | null;
  readonly missing: ReadonlyArray<{
    readonly generationMtIndex: number;
    /** Backing NIGHT in STAR. */
    readonly night: string;
    readonly backingNight: string;
    readonly generatingSince: string;
    readonly missingSince: string;
  }>;
  readonly excluded: number;
  readonly localApplied: number | null;
  readonly indexerMaxId: number | null;
  readonly behindBy: number | null;
  readonly stalled: boolean;
  readonly inconsistent: boolean;
  readonly revertedSubmissions: number;
  readonly liveEntries: number | null;
  readonly reason: string | null;
};

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
  /** Per-coin breakdown. Present whenever `ready`. */
  readonly coins?: {
    readonly shielded: {readonly available: readonly DaemonShieldedCoinWire[]; readonly pending: readonly DaemonShieldedCoinWire[]};
    readonly unshielded: {readonly available: readonly DaemonUnshieldedCoinWire[]; readonly pending: readonly DaemonUnshieldedCoinWire[]};
    readonly dust: {readonly available: readonly DaemonDustCoinWire[]; readonly pending: readonly DaemonDustCoinWire[]};
  };
  readonly subProgress?: SubWalletProgress;
  readonly dustGeneration?: DaemonDustGenerationWire | null;
  /** Whether the dust view is whole. Null when the sync session does not track it. */
  readonly dustView?: DaemonDustViewWire | null;
};

// ─────────────────────────────────────────────────────────────────────
// checkDustView (read) / rebuildDust / restartSync
// ─────────────────────────────────────────────────────────────────────

export type DaemonCheckDustViewResult = {
  readonly dustView: DaemonDustViewWire;
};

export type DaemonSyncRestartResult = {
  readonly started: boolean;
  readonly reason?: string;
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
// proveTransaction
// ─────────────────────────────────────────────────────────────────────

/**
 * Same shape as transferTokens plus a ttl, because this is that verb with
 * submission withheld: build, balance, prove and sign, then hand the
 * finalized transaction back as hex for the caller to submit later via
 * `submitTransaction`.
 *
 * Holding a proof is not free. See the note on buildTransferTransaction —
 * the proof binds fee-side DUST UTXOs by nullifier, so any other spend from
 * this wallet before submission invalidates it.
 */
export type DaemonProveTransactionParams = {
  readonly type: 'shielded' | 'unshielded';
  /** 64-char hex token id. NIGHT is '0' * 64. */
  readonly tokenId: string;
  /** Raw decimal amount in the token's smallest unit. */
  readonly amount: string;
  readonly to: string;
  /**
   * Intent deadline, in minutes from now. Clamped to [1, 60] — the ledger
   * rejects an intent whose ttl exceeds the including block by more than
   * 3600s. Defaults to 30 to match the build path's own default.
   */
  readonly ttlMinutes?: number;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonProveTransactionResult = {
  /** Hex-encoded FinalizedTransaction. Feed straight to submitTransaction. */
  readonly hex: string;
  /** Unix ms deadline. Submitting after this point is rejected. */
  readonly ttlUnix: number;
  readonly sizeBytes: number;
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
