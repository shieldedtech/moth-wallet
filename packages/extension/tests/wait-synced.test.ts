import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { waitForSyncedBalances, type BalanceSource } from '../lib/offscreen/wait-synced';

const balances = (synced: boolean): WalletBalances => ({ synced }) as WalletBalances;

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForSyncedBalances', () => {
  it('returns an already-synced snapshot without subscribing', async () => {
    const snapshot = balances(true);
    const subscribe = vi.fn();

    await expect(waitForSyncedBalances({ balances: snapshot, subscribe }, 100)).resolves.toBe(snapshot);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('handles a synced snapshot emitted synchronously by subscribe', async () => {
    const snapshot = balances(true);
    const stop = vi.fn();
    const source: BalanceSource = {
      balances: balances(false),
      subscribe(listener) {
        listener(snapshot);
        return stop;
      },
    };

    await expect(waitForSyncedBalances(source, 100)).resolves.toBe(snapshot);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes after a later synced snapshot', async () => {
    const snapshot = balances(true);
    const stop = vi.fn();
    let listener!: (value: WalletBalances) => void;
    const source: BalanceSource = {
      balances: balances(false),
      subscribe(next) {
        listener = next;
        return stop;
      },
    };

    const result = waitForSyncedBalances(source, 100);
    listener(snapshot);

    await expect(result).resolves.toBe(snapshot);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('times out and unsubscribes when sync never completes', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const source: BalanceSource = {
      balances: balances(false),
      subscribe: () => stop,
    };

    const result = waitForSyncedBalances(source, 100);
    const rejection = expect(result).rejects.toThrow('Wallet sync did not complete in time');
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
