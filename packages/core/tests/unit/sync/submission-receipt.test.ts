import { describe, expect, it, vi } from 'vitest';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk/facade';
import {
  rejectedTransactionHash,
  submitFinalizedTransaction,
  submitFinalizedTransactionWithReceipt,
  type FinalizedTransaction,
} from '../../../src/sync/operations.js';

const HASH = 'a'.repeat(64);
const finalized = { transactionHash: () => HASH } as unknown as FinalizedTransaction;

function facadeThat(submitTransaction: () => Promise<unknown>): WalletFacade {
  return { submitTransaction: vi.fn(submitTransaction) } as unknown as WalletFacade;
}

describe('submission receipt', () => {
  it('reports a submission the node saw through as included', async () => {
    const facade = facadeThat(async () => 'intent-id');

    await expect(submitFinalizedTransactionWithReceipt(facade, finalized)).resolves.toEqual({
      txHash: HASH,
      included: true,
    });
    await expect(submitFinalizedTransaction(facade, finalized)).resolves.toBe(HASH);
  });

  it('reports a transaction already in the pool as submitted but not included', async () => {
    // The node's 1013 sits below the SDK's own wrapper message.
    const facade = facadeThat(async () => {
      throw new Error('Transaction submission error', { cause: new Error('1013: Transaction Already Imported') });
    });

    await expect(submitFinalizedTransactionWithReceipt(facade, finalized)).resolves.toEqual({
      txHash: HASH,
      included: false,
    });
  });
});

describe('rejectedTransactionHash', () => {
  const rejection = async (): Promise<unknown> => {
    const facade = facadeThat(async () => {
      throw new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction') });
    });
    return submitFinalizedTransaction(facade, finalized).catch((error: unknown) => error);
  };

  it('names the transaction a rejected submission was for', async () => {
    expect(rejectedTransactionHash(await rejection())).toBe(HASH);
  });

  it('survives a caller rewrapping the rejection', async () => {
    const wrapped = new Error('dust ledger wedged', { cause: await rejection() });

    expect(rejectedTransactionHash(wrapped)).toBe(HASH);
  });

  it('is undefined for a failure that never reached submission', () => {
    expect(rejectedTransactionHash(new Error('proof server unreachable'))).toBeUndefined();
    expect(rejectedTransactionHash('not an error')).toBeUndefined();
  });
});
