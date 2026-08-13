// Batch transfer — load transfer list from JSON, execute sequentially, collect results.
// Supports file input or direct array input.

import { readFileSync } from 'node:fs';
import { sendTokensWithKeys, type SendRequest, type TxStage, type WalletKeys } from '../sync/operations.js';
import { NIGHT_TOKEN_ID } from '../sync/wallet-sync.js';

export interface BatchTransferEntry {
  to: string;
  amount: string;
  shielded?: boolean;
}

export interface BatchTransferResult {
  index: number;
  to: string;
  amount: string;
  status: 'success' | 'error';
  txHash?: string;
  error?: string;
}

export interface BatchTransferSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchTransferResult[];
}

/**
 * Load batch transfer list from a JSON file.
 * Expected format: array of { to, amount, shielded? }
 */
export function loadBatchFile(path: string): BatchTransferEntry[] {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Batch file must contain a JSON array of transfer entries');
  }
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry.to || typeof entry.to !== 'string') {
      throw new Error(`Entry ${i}: missing or invalid "to" address`);
    }
    if (!entry.amount || typeof entry.amount !== 'string') {
      throw new Error(`Entry ${i}: missing or invalid "amount" (must be string)`);
    }
  }
  return parsed;
}

/**
 * Execute batch transfers sequentially.
 * Returns summary with per-item results and three-tier exit code:
 *   0 = all succeeded, 1 = some failed, 2 = all failed
 */
export async function executeBatchTransfer(
  facade: any,
  walletKeys: WalletKeys,
  networkId: string,
  entries: BatchTransferEntry[],
  onProgress?: (index: number, stage: TxStage) => void,
): Promise<BatchTransferSummary> {
  const results: BatchTransferResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const parsed = parseFloat(entry.amount);
    if (Number.isNaN(parsed) || parsed <= 0) {
      results.push({
        index: i,
        to: entry.to,
        amount: entry.amount,
        status: 'error',
        error: `Invalid amount: ${entry.amount}`,
      });
      continue;
    }

    const req: SendRequest = {
      type: entry.shielded ? 'shielded' : 'unshielded',
      tokenId: NIGHT_TOKEN_ID,
      amount: BigInt(Math.round(parsed * 1_000_000)),
      to: entry.to,
    };

    try {
      const txHash = await sendTokensWithKeys(facade, walletKeys, networkId, [req], (stage) => {
        onProgress?.(i, stage);
      });
      results.push({
        index: i,
        to: entry.to,
        amount: entry.amount,
        status: 'success',
        txHash,
      });
    } catch (err) {
      results.push({
        index: i,
        to: entry.to,
        amount: entry.amount,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter(r => r.status === 'success').length;
  return {
    total: entries.length,
    succeeded,
    failed: entries.length - succeeded,
    results,
  };
}

/**
 * Three-tier exit code from batch results.
 */
export function batchExitCode(summary: BatchTransferSummary): 0 | 1 | 2 {
  if (summary.failed === 0) return 0;
  if (summary.succeeded === 0) return 1;
  return 2;
}
