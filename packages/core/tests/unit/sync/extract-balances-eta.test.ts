// The session's ETA tracker reaches overallSyncProgress through
// extractBalancesPartial, once per facade emission. The arithmetic is covered
// in progress.test.ts; this covers the hand-over, which nothing else would
// miss if it were dropped.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProgressRateTracker} from '../../../src/sync/progress.js';
import {extractBalancesPartial, type WalletBalances} from '../../../src/sync/wallet-sync.js';

type FacadeState = Parameters<typeof extractBalancesPartial>[0];

const SHIELDED_TOTAL = 184_376n;
const DUST_TOTAL = 1_000_000n;

const progress = (applied: bigint, total: bigint) => ({
  appliedIndex: applied,
  highestRelevantWalletIndex: total,
  isStrictlyComplete: () => applied === total,
});

// Shielded finished, DUST replaying alone at 1,000 events/s.
const emission = (second: number, shieldedBehind: bigint): FacadeState =>
  ({
    isSynced: false,
    shielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: progress(SHIELDED_TOTAL - shieldedBehind, SHIELDED_TOTAL)},
    unshielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: {appliedId: 0n, highestTransactionId: 0n, isStrictlyComplete: () => true}},
    dust: {balance: () => 0n, availableCoins: [], pendingCoins: [], progress: progress(BigInt(second) * 1_000n, DUST_TOTAL)},
  }) as unknown as FacadeState;

const session = (shieldedDips: (second: number) => boolean, rate?: ProgressRateTracker) => {
  const start = Date.now();
  let previous: WalletBalances | undefined;
  const shown: Array<number | null> = [];
  for (let second = 1; second <= 120; second++) {
    vi.setSystemTime(start + second * 1_000);
    previous = extractBalancesPartial(emission(second, shieldedDips(second) ? 1n : 0n), start, 0, rate, previous);
    shown.push(previous.syncProgress.etaSeconds);
  }
  return shown;
};

describe('extractBalancesPartial and the ETA tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('estimates from the tracker it is handed', () => {
    const shown = session(() => false, new ProgressRateTracker());
    expect(shown.slice(0, 29).every((eta) => eta === null)).toBe(true);
    // 30s at 0.1%/s leaves 96.9% → 969s, stretched by half.
    expect(shown[30]).toBe(1_454);
    expect(shown.slice(30).every((eta) => eta !== null)).toBe(true);
  });

  it('has no estimate without one', () => {
    expect(session(() => false).every((eta) => eta === null)).toBe(true);
  });

  it('keeps the estimate while the finished shielded wallet dips for an emission', () => {
    const steady = session(() => false, new ProgressRateTracker());
    const dipping = session((second) => second % 20 === 0, new ProgressRateTracker());
    expect(dipping).toEqual(steady);
  });
});
