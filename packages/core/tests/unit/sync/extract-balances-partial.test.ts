// A facade emission can say nothing about a sub-wallet: its progress slice is
// absent, its balance read throws before progress is read, or it reads 0/0
// while connected, which isStrictlyComplete() calls complete. The snapshot
// carries the last reading forward; the overall figure and the per-part flags
// must not take the gap for the sub-wallet finishing.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractBalancesPartial, type ProgressBaseline, type WalletBalances} from '../../../src/sync/wallet-sync.js';

type FacadeState = Parameters<typeof extractBalancesPartial>[0];
type Gap = 'dust-progress-missing' | 'dust-balance-throws' | 'dust-applied-zero' | 'dust-zero-of-zero';

const SHIELDED_TOTAL = 184_376n;
const DUST_TOTAL = 1_000_000n;

const progress = (applied: bigint, total: bigint) => ({
  appliedIndex: applied,
  highestRelevantWalletIndex: total,
  isStrictlyComplete: () => applied === total,
});

// Shielded finished, DUST replaying alone at 1,000 events/s.
const emission = (second: number, gap?: Gap, dustApplied = BigInt(second) * 1_000n): FacadeState =>
  ({
    isSynced: false,
    shielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: progress(SHIELDED_TOTAL, SHIELDED_TOTAL)},
    unshielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: {appliedId: 0n, highestTransactionId: 0n, isStrictlyComplete: () => true}},
    dust: {
      balance: () => {
        if (gap === 'dust-balance-throws') throw new Error('dust state not ready');
        return 0n;
      },
      availableCoins: [],
      pendingCoins: [],
      progress:
        gap === 'dust-progress-missing' ? undefined
        // Connected with nothing known yet: strictly complete, at 0 of 0.
        : gap === 'dust-zero-of-zero' ? progress(0n, 0n)
        : progress(gap === 'dust-applied-zero' ? 0n : dustApplied, DUST_TOTAL),
    },
  }) as unknown as FacadeState;

const session = (gapAt: (second: number) => Gap | undefined, dustAppliedAt?: (second: number) => bigint) => {
  const start = Date.now();
  const baseline: ProgressBaseline = {value: null};
  let previous: WalletBalances | undefined;
  const snapshots: WalletBalances[] = [];
  for (let second = 1; second <= 120; second++) {
    vi.setSystemTime(start + second * 1_000);
    const state = emission(second, gapAt(second), dustAppliedAt?.(second));
    previous = extractBalancesPartial(state, start, 0, baseline, previous);
    snapshots.push(previous);
  }
  return snapshots;
};
const every20s = (gap: Gap) => (second: number) => (second % 20 === 0 ? gap : undefined);
const none = () => undefined;

describe('extractBalancesPartial through an emission that says nothing about DUST', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each<Gap>(['dust-progress-missing', 'dust-balance-throws', 'dust-applied-zero', 'dust-zero-of-zero'])('%s, every 20s', (gap) => {
    it('keeps the percentage where it was instead of jumping to 99%', () => {
      const shown = session(every20s(gap)).map((b) => b.syncProgress.percentage);
      shown.forEach((pct, i) => expect(pct).toBeGreaterThanOrEqual(shown[i - 1] ?? 0));
      expect(Math.max(...shown)).toBeLessThan(0.2);
      expect(shown[19]).toBeCloseTo(0.019, 6);
    });

    it('does not mark DUST synced', () => {
      expect(session(every20s(gap)).some((b) => b.syncProgress.dustSynced)).toBe(false);
    });

    it('keeps the estimate, give or take the one stale second the gap contributes', () => {
      const steady = session(none).map((b) => b.syncProgress.etaSeconds);
      const gappy = session(every20s(gap)).map((b) => b.syncProgress.etaSeconds);
      // A reading one second stale moves the rate by about 1/elapsed: under 6% at 20s.
      gappy.forEach((eta, i) => {
        if (steady[i] === null) expect(eta).toBeNull();
        else expect(Math.abs(eta! - steady[i]!) / steady[i]!).toBeLessThan(0.1);
      });
    });
  });

  it('keeps a sub-wallet that really finished marked finished through a gap', () => {
    // DUST reaches its total at 60s, then an emission at 80s says nothing about it.
    const snapshots = session(
      (second) => (second === 80 ? 'dust-progress-missing' : undefined),
      (second) => (second >= 60 ? DUST_TOTAL : BigInt(second) * 1_000n),
    );
    expect(snapshots[59]!.syncProgress.dustSynced).toBe(true);
    expect(snapshots.slice(59).every((b) => b.syncProgress.dustSynced)).toBe(true);
  });
});
