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

// ─────────────────────────────────────────────────────────────────────
// cardanoAddress / cardanoBalance / cardanoStatus
// cardanoRegister / cardanoDeregister / cardanoUpdate
//
// Cardano verbs are only present on hosts that hold the wallet's mnemonic —
// CIP-1852 derivation needs BIP-39 entropy, which the daemon's derive-and-drop
// key bundle does not carry. Hosts that cannot supply one still answer these
// verbs, with a refusal that says why.
// ─────────────────────────────────────────────────────────────────────

export type DaemonCardanoAddressParams = Record<string, never> | null;

export type DaemonCardanoAddressResult = {
  readonly cardanoNetwork: string;
  readonly address: string;
  readonly rewardAddress: string;
  readonly stakeKeyHash: string;
  readonly paymentKeyHash: string;
  readonly midnightDustAddress: string;
};

export type DaemonCardanoBalanceParams = Record<string, never> | null;

export type DaemonCardanoBalanceResult = {
  readonly cardanoNetwork: string;
  /** Raw lovelace, as a decimal string — amounts exceed Number's safe range. */
  readonly lovelace: string;
  readonly cnight: string;
  readonly cnightUtxos: number;
  readonly cnightUnit: string;
};

export type DaemonCardanoStatusParams = Record<string, never> | null;

export type DaemonCardanoStatusResult = {
  readonly cardanoNetwork: string;
  readonly address: string;
  readonly rewardAddress: string;
  readonly lovelace: string;
  readonly cnight: string;
  readonly cnightUtxos: number;
  readonly registered: boolean;
  readonly registeredDustAddress: string | null;
  readonly registeredToThisWallet: boolean;
  /**
   * The registration records something that is not a 33-byte DUST address, so
   * Midnight can never match it: valid on Cardano, generating nothing.
   */
  readonly legacyDustAddress: boolean;
  readonly registrationUtxo: string | null;
  readonly mappingValidator: string;
  /** Midnight-side view; null until the indexer has observed the registration. */
  readonly dustGeneration: unknown | null;
};

export type DaemonCardanoRegisterParams = {
  /** DUST receiver: an `mn_dust_…` address or its 66-hex serialization. Defaults to this wallet's own. */
  readonly receiver?: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonCardanoRegisterResult = {
  readonly txHash: string;
  readonly receiver: string;
};

export type DaemonCardanoDeregisterParams = {
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonCardanoDeregisterResult = {
  readonly txHash: string;
  /** Registrations cleared. More than one means the stake key was in the
   *  duplicate state, where nothing generates. */
  readonly cleared: number;
};

export type DaemonCardanoUpdateParams = {
  /** DUST receiver: an `mn_dust_…` address or its 66-hex serialization. Required — this verb exists to change it. */
  readonly receiver: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonCardanoUpdateResult = {
  readonly txHash: string;
  readonly receiver: string;
};

export type DaemonCardanoSendParams = {
  readonly to: string;
  /** Decimal strings — lovelace and token counts both exceed Number's range. */
  readonly lovelace?: string;
  readonly cnight?: string;
  readonly summary?: string;
  readonly details?: readonly string[];
};

export type DaemonCardanoSendResult = {
  readonly txHash: string;
};
