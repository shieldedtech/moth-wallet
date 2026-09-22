import {describe, expect, it} from 'vitest';
import {
  EMPTY_DUST_VIEW,
  assessDustView,
  countRevertedSubmission,
  localDustCoins,
  markCheckFailed,
  markInconsistent,
  type LocalDustCoin,
} from '../../../src/sync/dust-view.js';
import type {DustGenerationEntry} from '../../../src/sync/dust-generations.js';

const T0 = Date.parse('2026-09-22T14:40:00Z');
const MIN = 60_000;

function entry(i: number, night: bigint, backingNight: string, ctimeMs = T0 - 17 * 3_600_000): DustGenerationEntry {
  return {
    generationMtIndex: i,
    commitmentMtIndex: 1_150_000 + i,
    night,
    initialValue: 0n,
    ctimeMs,
    backingNight,
    transactionHash: '4504f1c43081',
    dtimeMs: null,
  };
}

function coin(backingNight: string, over: Partial<LocalDustCoin> = {}): LocalDustCoin {
  return {backingNight, hasGenerationInfo: true, seq: 0, ctimeMs: T0 - MIN, initialValue: 1n, ...over};
}

// The preprod incident, 2026-09-22 14:40Z: two live entries (990 + 10 NIGHT), one
// coin visible. The 990 coin was hidden by a spend whose transaction never landed.
const BIG = '1e0d0fc0fa2c3a6be677e1a88e0e6463bfbd92f666608a65d6d87c8a955a8724';
const SMALL = '0ff2f705796e703dd63f0c0baa500908efc8d8895c7376ecd30ae323dea2bdf1';
const LIVE = [entry(397_203, 10_000_000n, SMALL), entry(397_204, 990_000_000n, BIG)];

describe('assessDustView', () => {
  it('is complete when every live entry has a coin and the cursor is at the tip', () => {
    const h = assessDustView({
      now: T0,
      live: LIVE,
      localCoins: [coin(SMALL, {seq: 16}), coin(BIG, {seq: 4})],
      localApplied: 1_549_223,
      indexerMaxId: 1_549_223,
    });
    expect(h.complete).toBe(true);
    expect(h.reason).toBeNull();
    expect(h.missing).toEqual([]);
    expect(h.liveEntries).toBe(2);
    expect(h.behindBy).toBe(0);
    expect(h.checkedAt).toBe(T0);
  });

  it('records a missing coin at once but only counts it against completeness after the grace', () => {
    const first = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL)], localApplied: 10, indexerMaxId: 10});
    // Seen missing — a coin spent seconds ago is hidden until its confirmation.
    expect(first.missing).toHaveLength(1);
    expect(first.missing[0]).toMatchObject({generationMtIndex: 397_204, night: 990_000_000n, missingSinceMs: T0});
    expect(first.complete).toBe(true);

    // Still missing nine minutes later: not yet.
    const second = assessDustView({
      now: T0 + 9 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL)],
      localApplied: 12,
      indexerMaxId: 12,
      previous: first,
    });
    expect(second.complete).toBe(true);
    expect(second.missing[0]!.missingSinceMs).toBe(T0);

    // Past the grace it is a hole, and the reason names the NIGHT behind it.
    const third = assessDustView({
      now: T0 + 11 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL)],
      localApplied: 14,
      indexerMaxId: 14,
      previous: second,
    });
    expect(third.complete).toBe(false);
    expect(third.reason).toMatch(/1 live generation entry backing 990 NIGHT have no coin/);
  });

  it('forgets a missing entry once the coin is back', () => {
    const missing = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL)], localApplied: 1, indexerMaxId: 1});
    const back = assessDustView({
      now: T0 + 20 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL), coin(BIG, {seq: 5})],
      localApplied: 2,
      indexerMaxId: 2,
      previous: missing,
    });
    expect(back.complete).toBe(true);
    expect(back.missing).toEqual([]);
  });

  it('honours a custom grace', () => {
    const first = assessDustView({now: T0, live: LIVE, localCoins: [], localApplied: 1, indexerMaxId: 1});
    const h = assessDustView({
      now: T0 + 2 * MIN,
      live: LIVE,
      localCoins: [],
      localApplied: 1,
      indexerMaxId: 1,
      previous: first,
      missingGraceMs: MIN,
    });
    expect(h.complete).toBe(false);
    expect(h.reason).toMatch(/2 live generation entries backing 1000 NIGHT/);
  });

  it('counts coins without generation info as excluded, immediately', () => {
    const h = assessDustView({
      now: T0,
      live: LIVE,
      localCoins: [coin(SMALL), coin(BIG, {hasGenerationInfo: false})],
      localApplied: 1,
      indexerMaxId: 1,
    });
    expect(h.excluded).toBe(1);
    expect(h.complete).toBe(false);
    expect(h.reason).toMatch(/1 coin\(s\) have no generation record/);
  });

  it('calls a cursor stalled only when it fails to move between two checks while the indexer does', () => {
    const behind = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL), coin(BIG)], localApplied: 100, indexerMaxId: 110});
    // One check behind is catching up.
    expect(behind.behindBy).toBe(10);
    expect(behind.stalled).toBe(false);
    expect(behind.complete).toBe(true);

    const movedOn = assessDustView({
      now: T0 + 5 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL), coin(BIG)],
      localApplied: 105,
      indexerMaxId: 120,
      previous: behind,
    });
    expect(movedOn.stalled).toBe(false);

    const stuck = assessDustView({
      now: T0 + 10 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL), coin(BIG)],
      localApplied: 105,
      indexerMaxId: 130,
      previous: movedOn,
    });
    expect(stuck.stalled).toBe(true);
    expect(stuck.complete).toBe(false);
    expect(stuck.reason).toMatch(/dust cursor stuck at 105 while the indexer is at 130/);
  });

  it('never reports a negative lag, and no lag at all without both cursors', () => {
    const ahead = assessDustView({now: T0, live: [], localCoins: [], localApplied: 50, indexerMaxId: 40});
    expect(ahead.behindBy).toBe(0);
    const unknown = assessDustView({now: T0, live: [], localCoins: [], localApplied: 50, indexerMaxId: null});
    expect(unknown.behindBy).toBeNull();
    expect(unknown.stalled).toBe(false);
  });

  it('carries the inconsistency and reverted-submission flags forward from the previous verdict', () => {
    const prev = countRevertedSubmission(markInconsistent(EMPTY_DUST_VIEW, 'ledger rejected dust replay at 1..2'));
    const h = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL), coin(BIG)], localApplied: 1, indexerMaxId: 1, previous: prev});
    expect(h.inconsistent).toBe(true);
    expect(h.revertedSubmissions).toBe(1);
    expect(h.complete).toBe(false);
    expect(h.reason).toMatch(/ledger rejected a replay/);
    // Explicitly clearing it (a rebuild) wins over the carry-forward.
    const cleared = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL), coin(BIG)], localApplied: 1, indexerMaxId: 1, previous: prev, inconsistent: false});
    expect(cleared.complete).toBe(true);
  });

  it('lists every problem in the reason', () => {
    const first = assessDustView({now: T0, live: LIVE, localCoins: [coin(SMALL, {hasGenerationInfo: false})], localApplied: 5, indexerMaxId: 9});
    const h = assessDustView({
      now: T0 + 15 * MIN,
      live: LIVE,
      localCoins: [coin(SMALL, {hasGenerationInfo: false})],
      localApplied: 5,
      indexerMaxId: 20,
      previous: first,
    });
    expect(h.complete).toBe(false);
    expect(h.reason).toMatch(/excluded/);
    expect(h.reason).toMatch(/no coin in the local view/);
    expect(h.reason).toMatch(/stuck/);
  });
});

describe('health record helpers', () => {
  it('markInconsistent flips completeness and keeps an existing reason', () => {
    const base = {...EMPTY_DUST_VIEW, complete: false, reason: 'stuck'};
    const h = markInconsistent(base, 'ledger rejected dust replay at 1..2');
    expect(h.complete).toBe(false);
    expect(h.inconsistent).toBe(true);
    expect(h.reason).toBe('ledger rejected dust replay at 1..2; stuck');
  });

  it('markCheckFailed records the time and explains only when there is nothing worse to say', () => {
    const fine = markCheckFailed(EMPTY_DUST_VIEW, T0, 'indexer unreachable');
    expect(fine.complete).toBe(true);
    expect(fine.checkedAt).toBe(T0);
    expect(fine.reason).toBe('last check failed: indexer unreachable');

    const broken = markCheckFailed({...EMPTY_DUST_VIEW, complete: false, reason: 'stuck'}, T0, 'indexer unreachable');
    expect(broken.reason).toBe('stuck');
  });
});

describe('localDustCoins', () => {
  it('reads coins and their generation-info presence out of a ledger-shaped state', () => {
    const utxos = [
      {backingNight: BIG, seq: 4, ctime: new Date(T0 - MIN), initialValue: 482_199_267_119_999_996n},
      {backingNight: SMALL, seq: 16, ctime: new Date(T0), initialValue: 180_040_799_999_984n},
    ];
    const coins = localDustCoins({
      utxos,
      generationInfo: (u) => (u.backingNight === BIG ? {value: 990_000_000n} : undefined),
    });
    expect(coins).toEqual([
      {backingNight: BIG, hasGenerationInfo: true, seq: 4, ctimeMs: T0 - MIN, initialValue: 482_199_267_119_999_996n},
      {backingNight: SMALL, hasGenerationInfo: false, seq: 16, ctimeMs: T0, initialValue: 180_040_799_999_984n},
    ]);
  });

  it('reads an absent or throwing state as no coins', () => {
    expect(localDustCoins(null)).toEqual([]);
    expect(
      localDustCoins({
        get utxos(): never {
          throw new Error('Dust secret key was cleared');
        },
        generationInfo: () => undefined,
      }),
    ).toEqual([]);
  });
});
