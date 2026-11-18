import { describe, expect, it, vi } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { estimateUnlessInFlight, hasTransactionInFlight } from '../lib/offscreen/fee-estimate';

type Coins = WalletBalances['coins'];

const noCoins = (): Coins => ({
  shielded: { available: [], pending: [] },
  unshielded: { available: [], pending: [] },
  dust: { available: [], pending: [] },
});

const dustCoin = {
  generatedNow: 5n,
  maxCap: 10n,
  rate: 1n,
  maxCapReachedAt: new Date(0),
  dtime: null,
};
const nightCoin = { value: 1n, type: 'night', registeredForDustGeneration: true, ctimeMs: null };

describe('hasTransactionInFlight', () => {
  it('is false for a wallet with nothing pending', () => {
    expect(hasTransactionInFlight({ ...noCoins(), dust: { available: [dustCoin], pending: [] } })).toBe(false);
  });

  it('sees a DUST coin booked as a fee input', () => {
    expect(hasTransactionInFlight({ ...noCoins(), dust: { available: [], pending: [dustCoin] } })).toBe(true);
  });

  it('sees an unshielded coin booked as a transfer input', () => {
    expect(hasTransactionInFlight({ ...noCoins(), unshielded: { available: [], pending: [nightCoin] } })).toBe(true);
  });

  it('sees shielded change still awaiting confirmation', () => {
    expect(
      hasTransactionInFlight({ ...noCoins(), shielded: { available: [], pending: [{ value: 1n, type: 't' }] } }),
    ).toBe(true);
  });
});

describe('estimateUnlessInFlight', () => {
  it('returns the fee as a decimal string', async () => {
    await expect(estimateUnlessInFlight(noCoins(), async () => 125_000_000_000_000n)).resolves.toEqual({
      fee: '125000000000000',
    });
  });

  it('prefers a real estimate even while a transaction is in flight', async () => {
    const coins = { ...noCoins(), dust: { available: [dustCoin], pending: [dustCoin] } };
    await expect(estimateUnlessInFlight(coins, async () => 7n)).resolves.toEqual({ fee: '7' });
  });

  it('reports a failure as waiting when an earlier transaction holds coins', async () => {
    const coins = { ...noCoins(), dust: { available: [], pending: [dustCoin] } };
    await expect(
      estimateUnlessInFlight(coins, () => Promise.reject(new Error('Insufficient funds'))),
    ).resolves.toEqual({ fee: null, reason: 'in-flight' });
  });

  it('passes any other failure through unchanged', async () => {
    const failure = new Error('Insufficient funds');
    await expect(estimateUnlessInFlight(noCoins(), () => Promise.reject(failure))).rejects.toBe(failure);
  });

  // The estimate books inputs of its own while it runs. A wallet whose only
  // pending coins are the estimate's own has nothing to wait for.
  it('decides from the coins as they were before the estimate ran', async () => {
    const coins = noCoins();
    const estimate = vi.fn(async () => {
      coins.dust.pending.push(dustCoin);
      throw new Error('Insufficient funds');
    });
    await expect(estimateUnlessInFlight(coins, estimate)).rejects.toThrow('Insufficient funds');
    expect(estimate).toHaveBeenCalledOnce();
  });
});
