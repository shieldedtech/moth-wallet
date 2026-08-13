// Wire-format parsers for every wallet daemon verb. Every handler runs
// its raw `unknown` params through one of these before doing anything
// else — the daemon should never see an invalid payload past this
// layer.
//
// Reject path: throw DaemonProtocolError with INVALID_PARAMS and a
// human-readable field name. The server-side dispatcher (server.ts)
// preserves the code on the wire so clients see INVALID_INPUT, not
// INTERNAL_ERROR.

import {DaemonProtocolError} from './protocol.js';
import type {
  DaemonCallCircuitParams,
  DaemonDeployContractParams,
  DaemonDustDeregisterParams,
  DaemonDustRegisterParams,
  DaemonInsertVerifierKeyParams,
  DaemonInsertVerifierKeysBatchParams,
  DaemonSubmitTransactionParams,
  DaemonTransferTokensParams,
} from './wallet-rpc-types.js';

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new DaemonProtocolError('INVALID_PARAMS', `${fieldName} must be a string`);
  }
  return value;
}

function parseOptionalStringArray(value: unknown, fieldName: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((d) => typeof d === 'string')) {
    throw new DaemonProtocolError('INVALID_PARAMS', `${fieldName} must be an array of strings`);
  }
  return value;
}

function requirePositiveTimeoutSec(raw: unknown, fieldName: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', `${fieldName} must be a positive number`);
  }
  return raw;
}

/** Truncate a hex string to <prefix>…<suffix>. */
export function shortenHex(hex: string): string {
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

/** Truncate a bech32m-style address. */
export function shortenAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

// ─────────────────────────────────────────────────────────────────────
// submitTransaction
// ─────────────────────────────────────────────────────────────────────

export function parseSubmitTransactionParams(raw: unknown): DaemonSubmitTransactionParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'submitTransaction params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.hex !== 'string' || p.hex.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'submitTransaction.hex must be a non-empty hex string');
  }
  if (!/^[0-9a-fA-F]*$/.test(p.hex) || p.hex.length % 2 !== 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'submitTransaction.hex must be even-length hex');
  }
  const summary = typeof p.summary === 'string' ? p.summary : undefined;
  const details = parseOptionalStringArray(p.details, 'submitTransaction.details');
  return {hex: p.hex, summary, details};
}

// ─────────────────────────────────────────────────────────────────────
// transferTokens
// ─────────────────────────────────────────────────────────────────────

export function parseTransferTokensParams(raw: unknown): DaemonTransferTokensParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens params must be an object');
  }
  const p = raw as Record<string, unknown>;

  if (p.type !== 'shielded' && p.type !== 'unshielded') {
    throw new DaemonProtocolError('INVALID_PARAMS', "transferTokens.type must be 'shielded' or 'unshielded'");
  }

  if (typeof p.tokenId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(p.tokenId)) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens.tokenId must be a 64-char hex string');
  }

  if (typeof p.amount !== 'string' || !/^\d+$/.test(p.amount)) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens.amount must be a non-negative decimal string');
  }
  let amountBig: bigint;
  try {
    amountBig = BigInt(p.amount);
  } catch {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens.amount must be parseable as bigint');
  }
  if (amountBig <= 0n) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens.amount must be greater than zero');
  }

  if (typeof p.to !== 'string' || p.to.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'transferTokens.to must be a non-empty bech32m address string');
  }

  return {
    type: p.type,
    tokenId: p.tokenId.toLowerCase(),
    amount: p.amount,
    to: p.to,
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'transferTokens.details'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// callCircuit
// ─────────────────────────────────────────────────────────────────────

export function parseCallCircuitParams(raw: unknown): DaemonCallCircuitParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'callCircuit params must be an object');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.contractAddress !== 'string' || p.contractAddress.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'callCircuit.contractAddress must be a non-empty bech32m string');
  }
  if (typeof p.circuitName !== 'string' || p.circuitName.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'callCircuit.circuitName must be a non-empty string');
  }
  if (typeof p.artifactPath !== 'string' || p.artifactPath.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'callCircuit.artifactPath must be a non-empty path string');
  }

  return {
    contractAddress: p.contractAddress,
    circuitName: p.circuitName,
    args: parseOptionalString(p.args, 'callCircuit.args'),
    artifactPath: p.artifactPath,
    witnessesPath: parseOptionalString(p.witnessesPath, 'callCircuit.witnessesPath'),
    projectDir: parseOptionalString(p.projectDir, 'callCircuit.projectDir'),
    timeoutSec: requirePositiveTimeoutSec(p.timeoutSec, 'callCircuit.timeoutSec'),
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'callCircuit.details'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// deployContract
// ─────────────────────────────────────────────────────────────────────

export function parseDeployContractParams(raw: unknown): DaemonDeployContractParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'deployContract params must be an object');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.artifactPath !== 'string' || p.artifactPath.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'deployContract.artifactPath must be a non-empty path string');
  }
  return {
    artifactPath: p.artifactPath,
    witnessesPath: parseOptionalString(p.witnessesPath, 'deployContract.witnessesPath'),
    projectDir: parseOptionalString(p.projectDir, 'deployContract.projectDir'),
    timeoutSec: requirePositiveTimeoutSec(p.timeoutSec, 'deployContract.timeoutSec'),
    args: parseOptionalString(p.args, 'deployContract.args'),
    privateState: parseOptionalString(p.privateState, 'deployContract.privateState'),
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'deployContract.details'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// dustRegister / dustDeregister
// ─────────────────────────────────────────────────────────────────────

export function parseDustRegisterParams(raw: unknown): DaemonDustRegisterParams {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'dustRegister params must be an object or omitted');
  }
  const p = raw as Record<string, unknown>;
  const receiver = parseOptionalString(p.receiver, 'dustRegister.receiver');
  if (receiver !== undefined && receiver.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'dustRegister.receiver must be a non-empty bech32m string');
  }
  return {
    receiver,
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'dustRegister.details'),
  };
}

export function parseDustDeregisterParams(raw: unknown): DaemonDustDeregisterParams {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'dustDeregister params must be an object or omitted');
  }
  const p = raw as Record<string, unknown>;
  return {
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'dustDeregister.details'),
  };
}

// ─────────────────────────────────────────────────────────────────────
// insertVerifierKey / insertVerifierKeysBatch
// ─────────────────────────────────────────────────────────────────────

export function parseInsertVerifierKeyParams(raw: unknown): DaemonInsertVerifierKeyParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKey params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.contractAddress !== 'string' || p.contractAddress.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKey.contractAddress must be a non-empty bech32m string');
  }
  if (typeof p.circuitId !== 'string' || p.circuitId.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKey.circuitId must be a non-empty string');
  }
  if (typeof p.verifierKeyPath !== 'string' || p.verifierKeyPath.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKey.verifierKeyPath must be a non-empty path string');
  }
  if (typeof p.artifactPath !== 'string' || p.artifactPath.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKey.artifactPath must be a non-empty path string');
  }
  return {
    contractAddress: p.contractAddress,
    circuitId: p.circuitId,
    verifierKeyPath: p.verifierKeyPath,
    artifactPath: p.artifactPath,
    projectDir: parseOptionalString(p.projectDir, 'insertVerifierKey.projectDir'),
    timeoutSec: requirePositiveTimeoutSec(p.timeoutSec, 'insertVerifierKey.timeoutSec'),
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'insertVerifierKey.details'),
  };
}

export function parseInsertVerifierKeysBatchParams(raw: unknown): DaemonInsertVerifierKeysBatchParams {
  if (!raw || typeof raw !== 'object') {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKeysBatch params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.contractAddress !== 'string' || p.contractAddress.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKeysBatch.contractAddress must be a non-empty bech32m string');
  }
  if (typeof p.artifactPath !== 'string' || p.artifactPath.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKeysBatch.artifactPath must be a non-empty path string');
  }
  if (!Array.isArray(p.entries) || p.entries.length === 0) {
    throw new DaemonProtocolError('INVALID_PARAMS', 'insertVerifierKeysBatch.entries must be a non-empty array');
  }
  const entries = p.entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new DaemonProtocolError('INVALID_PARAMS', `insertVerifierKeysBatch.entries[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.circuitId !== 'string' || e.circuitId.length === 0) {
      throw new DaemonProtocolError('INVALID_PARAMS', `insertVerifierKeysBatch.entries[${i}].circuitId must be a non-empty string`);
    }
    if (typeof e.verifierKeyPath !== 'string' || e.verifierKeyPath.length === 0) {
      throw new DaemonProtocolError('INVALID_PARAMS', `insertVerifierKeysBatch.entries[${i}].verifierKeyPath must be a non-empty path string`);
    }
    return {circuitId: e.circuitId, verifierKeyPath: e.verifierKeyPath};
  });
  return {
    contractAddress: p.contractAddress,
    artifactPath: p.artifactPath,
    entries,
    projectDir: parseOptionalString(p.projectDir, 'insertVerifierKeysBatch.projectDir'),
    skipExisting: p.skipExisting === undefined ? undefined : !!p.skipExisting,
    timeoutSec: requirePositiveTimeoutSec(p.timeoutSec, 'insertVerifierKeysBatch.timeoutSec'),
    summary: typeof p.summary === 'string' ? p.summary : undefined,
    details: parseOptionalStringArray(p.details, 'insertVerifierKeysBatch.details'),
  };
}
