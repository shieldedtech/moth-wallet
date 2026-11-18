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

type Gap = 'shielded-dips' | 'dust-progress-missing' | 'dust-balance-throws' | 'dust-applied-zero';

// Shielded finished, DUST replaying alone at 1,000 events/s.
const emission = (second: number, gap?: Gap): FacadeState =>
  ({
    isSynced: false,
    shielded: {
      balances: {}, availableCoins: [], pendingCoins: [],
      progress: progress(SHIELDED_TOTAL - (gap === 'shielded-dips' ? 1n : 0n), SHIELDED_TOTAL),
    },
    unshielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: {appliedId: 0n, highestTransactionId: 0n, isStrictlyComplete: () => true}},
    dust: {
      balance: () => {
        if (gap === 'dust-balance-throws') throw new Error('dust state not ready');
        return 0n;
      },
      availableCoins: [], pendingCoins: [],
      progress: gap === 'dust-progress-missing' ? undefined : progress(gap === 'dust-applied-zero' ? 0n : BigInt(second) * 1_000n, DUST_TOTAL),
    },
  }) as unknown as FacadeState;

const session = (gapAt: (second: number) => Gap | undefined, rate?: ProgressRateTracker) => {
  const start = Date.now();
  let previous: WalletBalances | undefined;
  const snapshots: WalletBalances[] = [];
  for (let second = 1; second <= 120; second++) {
    vi.setSystemTime(start + second * 1_000);
    previous = extractBalancesPartial(emission(second, gapAt(second)), start, 0, rate, previous);
    snapshots.push(previous);
  }
  return snapshots;
};
const etas = (snapshots: WalletBalances[]) => snapshots.map((b) => b.syncProgress.etaSeconds);
const every20s = (gap: Gap) => (second: number) => (second % 20 === 0 ? gap : undefined);
const none = () => undefined;

describe('extractBalancesPartial and the ETA tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('estimates from the tracker it is handed', () => {
    const shown = etas(session(none, new ProgressRateTracker()));
    expect(shown.slice(0, 29).every((eta) => eta === null)).toBe(true);
    // 30s at 0.1%/s leaves 96.9% → 969s, stretched by half.
    expect(shown[30]).toBe(1_454);
    expect(shown.slice(30).every((eta) => eta !== null)).toBe(true);
  });

  it('has no estimate without one', () => {
    expect(etas(session(none)).every((eta) => eta === null)).toBe(true);
  });

  it('keeps the estimate while the finished shielded wallet dips for an emission', () => {
    const steady = etas(session(none, new ProgressRateTracker()));
    const dipping = etas(session(every20s('shielded-dips'), new ProgressRateTracker()));
    expect(dipping).toEqual(steady);
  });

  // An emission that says nothing about the sub-wallet still replaying is a
  // gap in the report, not in the replay: the snapshot carries the last
  // reading forward, and the ETA's samples must see that reading too.
  describe.each<Gap>(['dust-progress-missing', 'dust-balance-throws', 'dust-applied-zero'])('through a %s emission every 20s', (gap) => {
    it('keeps the estimate, within the one stale second each gap contributes', () => {
      const steady = etas(session(none, new ProgressRateTracker()));
      const gappy = etas(session(every20s(gap), new ProgressRateTracker()));
      gappy.forEach((eta, i) => {
        if (steady[i] === null) expect(eta).toBeNull();
        else expect(Math.abs(eta! - steady[i]!) / steady[i]!).toBeLessThan(0.05);
      });
    });

    it('keeps the percentage where it was', () => {
      const shown = session(every20s(gap), new ProgressRateTracker()).map((b) => b.syncProgress.percentage);
      shown.forEach((pct, i) => expect(pct).toBeGreaterThanOrEqual(shown[i - 1] ?? 0));
      expect(shown[19]).toBeCloseTo(0.019, 6);
    });
  });
});
