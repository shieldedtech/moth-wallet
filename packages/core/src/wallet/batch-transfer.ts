// Batch transfer — load transfer list from JSON, execute sequentially, collect results.
// Supports file input or direct array input.

import { readFileSync } from 'node:fs';
import { sendTokensWithKeys, type SendRequest, type TxStage, type WalletKeys } from '../sync/operations.js';
import { NIGHT_TOKEN_ID } from '../sync/wallet-sync.js';
import { InvalidAmountError, parseNightAmount } from './night-amount.js';

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
    // Amount syntax is a static property of the file, so check it here rather
    // than discovering it on entry 7 with six transfers already submitted. This
    // function already refuses the whole file for a missing field; a
    // meaningless amount is the same kind of defect.
    try {
      parseNightAmount(entry.amount);
    } catch (err) {
      throw new Error(`Entry ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return parsed;
}

/**
 * Execute batch transfers sequentially.
 * Returns summary with per-item results and three-tier exit code:
 *   0 = all succeeded, 1 = some failed, 2 = all failed
 *
 * Amounts are validated per entry as well as in `loadBatchFile`, because
 * `transfer batch @stdin` JSON.parses straight into here and never goes through
 * the loader.
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

    // The same parser `moth transfer` and the daemon use. The previous
    // `parseFloat` + `Math.round(x * 1_000_000)` accepted an entry it could not
    // understand as a DIFFERENT amount: "1,5" became 1 NIGHT, "1e3" became 1000,
    // and "0.0000001" rounded to zero base units and was submitted as a transfer
    // of nothing that still paid a fee. A batch file is where those arrive —
    // generated or pasted, with no prompt to read (#66, the #63 bug in this path).
    let amount: bigint;
    try {
      amount = parseNightAmount(entry.amount);
    } catch (err) {
      results.push({
        index: i,
        to: entry.to,
        amount: entry.amount,
        status: 'error',
        error: err instanceof InvalidAmountError ? err.message : `Invalid amount: ${entry.amount}`,
      });
      continue;
    }

    const req: SendRequest = {
      type: entry.shielded ? 'shielded' : 'unshielded',
      tokenId: NIGHT_TOKEN_ID,
      amount,
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
 * Three-tier exit code from batch results: 0 all succeeded, 1 partial, 2 all
 * failed — the contract stated above, in the README, and in the test plan.
 *
 * The two failure codes were the wrong way round: a batch where everything
 * failed returned 1 and one where only some entries failed returned 2. That
 * inverts the signal automation keys on — a caller treating 2 as "nothing went
 * out, re-send the file" would re-send a batch whose successful entries had
 * already been submitted (#67).
 */
export function batchExitCode(summary: BatchTransferSummary): 0 | 1 | 2 {
  if (summary.failed === 0) return 0;
  if (summary.succeeded === 0) return 2;
  return 1;
}
