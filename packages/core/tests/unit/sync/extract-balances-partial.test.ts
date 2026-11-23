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
      // Shielded done and DUST behind; the empty unshielded side is left out.
      expect(Math.max(...shown)).toBeLessThan(0.6);
      expect(shown[19]).toBeCloseTo((1 + 0.019) / 2, 6);
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

// Before the sub-wallets connect, every part reads 0/0 and none is strictly
// complete. On a fresh preprod wallet that showed 99% with 0s remaining for the
// first seconds, then 0%, and the 99% became the ETA baseline, so no estimate
// appeared for the rest of the sync.
describe('extractBalancesPartial before the sub-wallets connect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reading = (applied: bigint, total: bigint, complete: boolean) => ({
    appliedIndex: applied,
    highestRelevantWalletIndex: total,
    isStrictlyComplete: () => complete,
  });
  const unshieldedReading = (complete: boolean) => ({appliedId: 0n, highestTransactionId: 0n, isStrictlyComplete: () => complete});
  const silent = reading(0n, 0n, false);

  // Nothing connected for the first 5s; then shielded finishes, unshielded is
  // empty, and DUST replays at 1,000 events/s.
  const startup = (second: number, unshieldedComplete = true): FacadeState =>
    ({
      isSynced: false,
      shielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: second <= 5 ? silent : reading(SHIELDED_TOTAL, SHIELDED_TOTAL, true)},
      unshielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: unshieldedReading(second > 5 && unshieldedComplete)},
      dust: {
        balance: () => 0n,
        availableCoins: [],
        pendingCoins: [],
        progress: second <= 5 ? silent : reading(BigInt(second - 5) * 1_000n, DUST_TOTAL, false),
      },
    }) as unknown as FacadeState;

  const run = (stateAt: (second: number) => FacadeState) => {
    const start = Date.now();
    const baseline: ProgressBaseline = {value: null};
    let previous: WalletBalances | undefined;
    const snapshots: WalletBalances[] = [];
    for (let second = 1; second <= 60; second++) {
      vi.setSystemTime(start + second * 1_000);
      previous = extractBalancesPartial(stateAt(second), start, 0, baseline, previous);
      snapshots.push(previous);
    }
    return snapshots;
  };

  it('reads 0% until a sub-wallet reports, not 99%', () => {
    const shown = run((s) => startup(s)).map((b) => b.syncProgress.percentage);
    expect(shown.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    shown.forEach((pct, i) => expect(pct).toBeGreaterThanOrEqual(shown[i - 1] ?? 0));
    expect(Math.max(...shown)).toBeLessThan(0.6);
  });

  it('gives an estimate once DUST is moving', () => {
    const etas = run((s) => startup(s)).map((b) => b.syncProgress.etaSeconds);
    expect(etas.slice(0, 5).every((eta) => eta === null)).toBe(true);
    // 1,000 of 1,000,000 events a second: about 1,000s in all.
    expect(etas.at(-1)).toBeGreaterThan(800);
    expect(etas.at(-1)).toBeLessThan(1_000);
  });

  it('does not drop to 0% when an empty sub-wallet stops reporting complete', () => {
    // An empty unshielded side reads 0/0 throughout; a dropped connection makes it
    // not strictly complete. It finished earlier this session, so it still counts.
    const shown = run((s) => startup(s, !(s >= 30 && s <= 32))).map((b) => b.syncProgress);
    expect(shown.slice(29, 32).every((p) => p.unshieldedSynced)).toBe(true);
    shown.slice(6).forEach((p, i) => expect(p.percentage).toBeGreaterThanOrEqual(shown[i + 5]!.percentage));
  });
});

describe('extractBalancesPartial while the only DUST coin is pending', () => {
  const coin = {generatedNow: 5n, maxCap: 10n, rate: 1n, maxCapReachedAt: new Date(0), dtime: null};
  const state = (available: unknown[], pending: unknown[]): FacadeState =>
    ({
      isSynced: true,
      shielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: progress(1n, 1n)},
      unshielded: {balances: {}, availableCoins: [], pendingCoins: [], progress: {appliedId: 0n, highestTransactionId: 0n, isStrictlyComplete: () => true}},
      dust: {balance: () => 0n, availableCoins: available, pendingCoins: pending, progress: progress(1n, 1n)},
    }) as unknown as FacadeState;

  it('reports the coin as pending, not the previous snapshot\'s available coin', () => {
    const before = extractBalancesPartial(state([coin], []));
    expect(before.coins.dust.available).toHaveLength(1);
    const after = extractBalancesPartial(state([], [coin]), 0, 0, undefined, before);
    expect(after.coins.dust.available).toHaveLength(0);
    expect(after.coins.dust.pending).toHaveLength(1);
  });

  it('still carries the coins forward through an emission with none at all', () => {
    const before = extractBalancesPartial(state([coin], []));
    const gap = extractBalancesPartial(state([], []), 0, 0, undefined, before);
    expect(gap.coins.dust.available).toHaveLength(1);
  });

  // A emission whose DUST slice is missing, or whose balance() throws before the
  // coins are read.
  const unread = (how: 'missing' | 'throws'): FacadeState => {
    const s = state([], []) as unknown as {dust: unknown};
    s.dust = how === 'missing' ? undefined : {balance: () => { throw new Error('mid-read'); }, availableCoins: [], pendingCoins: []};
    return s as unknown as FacadeState;
  };

  it.each(['missing', 'throws'] as const)('keeps a pending-only list through a later unread emission (%s)', (how) => {
    const a = extractBalancesPartial(state([coin], []));
    const b = extractBalancesPartial(state([], [coin]), 0, 0, undefined, a);
    const c = extractBalancesPartial(unread(how), 0, 0, undefined, b);
    expect(c.coins.dust.pending).toHaveLength(1);
    expect(c.coins.dust.available).toHaveLength(0);
  });

  it('shows a sweep of the last coin as empty, not as still pending', () => {
    const pending = extractBalancesPartial(state([], [coin]));
    const swept = extractBalancesPartial(state([], []), 0, 0, undefined, pending);
    expect(swept.coins.dust.pending).toHaveLength(0);
    expect(swept.coins.dust.available).toHaveLength(0);
  });
});

