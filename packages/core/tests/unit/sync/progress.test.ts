// Overall sync progress must track the slowest sub-wallet.
//
// Regression for a wallet that reported "100% (0s remaining)" while dust sat at
// 178,029 of 1,395,558 events with roughly 69 minutes of work left. The figure
// came from shielded indices alone, on the assumption that shielded was the
// slowest sub-wallet — it is not; dust is, by two orders of magnitude.

import {describe, expect, it} from 'vitest';
import {overallSyncProgress, ProgressRateTracker} from '../../../src/sync/progress.js';

const complete = {applied: 1_395_558, total: 1_395_558};

describe('overallSyncProgress', () => {
  it('reports the slowest sub-wallet, not the shielded one', () => {
    // The exact state observed on preprod: shielded and unshielded done, dust 12%.
    const {percentage} = overallSyncProgress({
      shielded: complete,
      unshielded: {applied: 0, total: 0},
      dust: {applied: 178_029, total: 1_395_558},
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 600_000,
    });

    expect(Math.round(percentage * 100)).toBe(13); // was 100
  });

  it('estimates the remaining time from the sub-wallet that is behind', () => {
    // Dust gained ~1.3 points over the last minute at ~12.8%: well over an
    // hour left, not 0s.
    const rate = new ProgressRateTracker();
    const dustAt = (applied: number, elapsedMs: number) =>
      overallSyncProgress({
        shielded: complete,
        unshielded: {applied: 0, total: 0},
        dust: {applied, total: 1_395_558},
        shieldedSynced: true,
        unshieldedSynced: true,
        dustSynced: false,
        synced: false,
        elapsedMs,
        rate,
      });
    dustAt(160_000, 540_000);
    const {etaSeconds} = dustAt(178_029, 600_000);

    expect(etaSeconds).toBeGreaterThan(3000); // was 0
  });

  it('never reports 100% while the wallet is not synced', () => {
    // A hair short of complete must not round up — that is the original lie.
    const {percentage} = overallSyncProgress({
      shielded: complete,
      unshielded: complete,
      dust: {applied: 1_395_557, total: 1_395_558},
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 60_000,
    });

    expect(percentage).toBeLessThan(1);
    expect(Math.round(percentage * 100)).toBe(99);
  });

  it('reports exactly 100% and no remaining time once synced', () => {
    const {percentage, etaSeconds} = overallSyncProgress({
      shielded: complete,
      unshielded: complete,
      dust: complete,
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: true,
      synced: true,
      elapsedMs: 60_000,
    });

    expect(percentage).toBe(1);
    expect(etaSeconds).toBe(0);
  });

  it('treats a sub-wallet with nothing to apply as complete', () => {
    // A fresh wallet's unshielded progress is legitimately 0/0. Counting that as
    // zero would peg the whole wallet at 0% forever.
    const {percentage} = overallSyncProgress({
      shielded: {applied: 500, total: 1000},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 750, total: 1000},
      shieldedSynced: false,
      unshieldedSynced: false,
      dustSynced: false,
      synced: false,
      elapsedMs: 10_000,
    });

    expect(percentage).toBeCloseTo(0.5, 5); // shielded is the slowest here
  });

  it('omits an estimate before there is enough signal', () => {
    const {etaSeconds} = overallSyncProgress({
      shielded: {applied: 1, total: 1_000_000},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 1, total: 1_000_000},
      shieldedSynced: false,
      unshieldedSynced: false,
      dustSynced: false,
      synced: false,
      elapsedMs: 5_000,
    });

    expect(etaSeconds).toBeNull();
  });
});

// Reporting the minimum without saying whose it is produced a genuinely
// confusing debug timeline: "syncing 27%" beside a UI showing shielded and
// unshielded at 100%, which reads as a contradiction rather than as dust being
// the constraint.
describe('which sub-wallet is binding', () => {
  const base = {
    shielded: {applied: 100, total: 100},
    unshielded: {applied: 100, total: 100},
    dust: {applied: 30, total: 100},
    shieldedSynced: true,
    unshieldedSynced: true,
    dustSynced: false,
    synced: false,
    elapsedMs: 0,
  };

  it('names dust when dust is behind — the reported case', () => {
    const r = overallSyncProgress(base);
    expect(r.slowest).toBe('dust');
    expect(Math.round(r.percentage * 100)).toBe(30);
  });

  it('names shielded when shielded is behind', () => {
    const r = overallSyncProgress({
      ...base,
      shielded: {applied: 10, total: 100},
      shieldedSynced: false,
      dust: {applied: 90, total: 100},
    });
    expect(r.slowest).toBe('shielded');
  });

  it('names unshielded when unshielded is behind', () => {
    const r = overallSyncProgress({
      ...base,
      unshielded: {applied: 5, total: 100},
      unshieldedSynced: false,
    });
    expect(r.slowest).toBe('unshielded');
  });

  it('reports no binding sub-wallet once synced', () => {
    expect(overallSyncProgress({...base, synced: true}).slowest).toBeNull();
  });

  it('agrees with the percentage it returns', () => {
    // The label and the number must come from the same sub-wallet, or the line
    // is worse than no label at all.
    const r = overallSyncProgress({...base, dust: {applied: 42, total: 100}});
    expect(r.slowest).toBe('dust');
    expect(Math.round(r.percentage * 100)).toBe(42);
  });
});

// Dust alone still replaying, as every resumed sync looks within seconds.
const dustAlone = (fraction: number, elapsedMs: number, rate?: ProgressRateTracker) =>
  overallSyncProgress({
    shielded: {applied: 1, total: 1},
    unshielded: {applied: 1, total: 1},
    dust: {applied: Math.round(fraction * 1_000_000), total: 1_000_000},
    shieldedSynced: true, unshieldedSynced: true, dustSynced: false,
    synced: false, elapsedMs, rate,
  });

describe('ETA on a resumed sync', () => {
  // The bug, in the numbers it produced on preprod. A run that restored dust at
  // ~65% and then ran 152s was read as "67% in 152s" — 15x the real rate — so it
  // promised 1m15s against a true ~10m, and the estimate CLIMBED as elapsed time
  // corrected the fiction: 2m23s by the time it reached 81%.
  it('no longer reads resumed progress as this session\'s work', () => {
    const rate = new ProgressRateTracker();
    dustAlone(0.65, 0, rate);
    const early = dustAlone(0.67, 152_000, rate);
    const later = dustAlone(0.81, 622_000, rate);
    // 2 points in 152s → 33 points remaining ≈ 2500s. Nothing like 75s.
    expect(early.etaSeconds).toBeGreaterThan(1_000);
    // An honest estimate FALLS as the run proceeds; the broken one rose.
    expect(later.etaSeconds!).toBeLessThan(early.etaSeconds!);
  });

  it('measures the rate over this session only', () => {
    // 10 points in 100s → 0.1 points/s → 50 points left → 500s.
    const rate = new ProgressRateTracker();
    dustAlone(0.4, 0, rate);
    expect(dustAlone(0.5, 100_000, rate).etaSeconds).toBe(500);
  });

  it('accounts for a first sample taken after the clock started', () => {
    // First sample at 20s/40%, now 120s/60%: 20 points in 100s → 40 left → 200s.
    const rate = new ProgressRateTracker();
    dustAlone(0.4, 20_000, rate);
    expect(dustAlone(0.6, 120_000, rate).etaSeconds).toBe(200);
  });

  it('says nothing rather than guessing before there is movement to measure', () => {
    const tooLittle = new ProgressRateTracker();
    dustAlone(0.4, 0, tooLittle);
    expect(dustAlone(0.4001, 1_500, tooLittle).etaSeconds).toBeNull();
    const none = new ProgressRateTracker();
    dustAlone(0.4, 0, none);
    expect(dustAlone(0.4, 60_000, none).etaSeconds).toBeNull();
  });

  it('says nothing without a sample to measure from', () => {
    // This used to extrapolate the whole run from its first percent — the
    // "2h 8min left" a mainnet wallet showed at 40%, nine minutes before it
    // finished. One sample is not a rate.
    expect(dustAlone(0.5, 100_000).etaSeconds).toBeNull();
    expect(dustAlone(0.5, 100_000, new ProgressRateTracker()).etaSeconds).toBeNull();
  });

  it('is 0 once synced, samples or not', () => {
    const rate = new ProgressRateTracker();
    dustAlone(0.9, 0, rate);
    const r = overallSyncProgress({
      shielded: {applied: 1, total: 1}, unshielded: {applied: 1, total: 1}, dust: {applied: 1, total: 1},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: true,
      synced: true, elapsedMs: 5_000, rate,
    });
    expect(r.etaSeconds).toBe(0);
  });
});

// A replay has no one rate. Measured on mainnet: the DUST walk ran at ~25
// events/s while the shielded walk ran beside it, then at ~1,500/s once alone,
// so a rate taken over the whole session promised "3h 19m" at 1% of a sync that
// finished seven minutes later.
describe('ETA follows the current rate', () => {
  it('shows no estimate while two sub-wallets replay at once', () => {
    const rate = new ProgressRateTracker();
    const both = (shielded: number, dust: number, elapsedMs: number) =>
      overallSyncProgress({
        shielded: {applied: shielded, total: 184_376},
        unshielded: {applied: 0, total: 0},
        dust: {applied: dust, total: 185_388},
        shieldedSynced: false, unshieldedSynced: false, dustSynced: false,
        synced: false, elapsedMs, rate,
      });
    both(31_473, 136, 17_000);
    both(60_229, 1_033, 80_000);
    const r = both(82_445, 1_963, 129_000);
    // The percentage still reports the sub-wallet that is behind…
    expect(r.slowest).toBe('dust');
    // …but the rate it is crawling at is not the rate it will finish at.
    expect(r.etaSeconds).toBeNull();
  });

  it('does not carry the starved rate into the phase where dust runs alone', () => {
    const rate = new ProgressRateTracker();
    overallSyncProgress({
      shielded: {applied: 10_000, total: 184_376}, unshielded: {applied: 0, total: 0},
      dust: {applied: 100, total: 185_388},
      shieldedSynced: false, unshieldedSynced: false, dustSynced: false,
      synced: false, elapsedMs: 0, rate,
    });
    overallSyncProgress({
      shielded: {applied: 140_000, total: 184_376}, unshielded: {applied: 0, total: 0},
      dust: {applied: 2_383, total: 185_388},
      shieldedSynced: false, unshieldedSynced: false, dustSynced: false,
      synced: false, elapsedMs: 144_000, rate,
    });
    // Shielded done: dust is alone and its rate starts over.
    expect(dustAlone(8_433 / 185_388, 159_000, rate).etaSeconds).toBeNull();
    const eta = dustAlone(14_870 / 185_388, 174_000, rate).etaSeconds!;
    // 6,437 events in 15s → ~170,500 left → ~400s. The whole-session rate
    // (14,870 in 174s) would have said ~2,000s.
    expect(eta).toBeGreaterThan(300);
    expect(eta).toBeLessThan(500);
  });

  it('measures over a window, so an early slow stretch stops weighing on it', () => {
    const rate = new ProgressRateTracker();
    dustAlone(0.01, 0, rate);
    // A slow minute: 1 point in 100s would be ~9,900s remaining.
    dustAlone(0.02, 100_000, rate);
    // Then 1 point per second.
    dustAlone(0.3, 130_000, rate);
    dustAlone(0.6, 160_000, rate);
    const eta = dustAlone(0.9, 200_000, rate).etaSeconds!;
    // Measured from the 100s sample once the window has dropped the first:
    // 88 points in 100s → 10 left → ~11s.
    expect(eta).toBeLessThan(20);
  });
});

describe('ProgressRateTracker', () => {
  const phase = 'dust';

  it('has nothing to measure from on the first sample of a phase', () => {
    expect(new ProgressRateTracker().observe(phase, {fraction: 0.1, elapsedMs: 0})).toBeUndefined();
  });

  it('measures from the oldest sample still inside the window', () => {
    const rate = new ProgressRateTracker();
    rate.observe(phase, {fraction: 0, elapsedMs: 0}, 10_000);
    expect(rate.observe(phase, {fraction: 0.1, elapsedMs: 5_000}, 10_000)).toEqual({fraction: 0, elapsedMs: 0});
    expect(rate.observe(phase, {fraction: 0.2, elapsedMs: 12_000}, 10_000)).toEqual({fraction: 0, elapsedMs: 0});
    expect(rate.observe(phase, {fraction: 0.3, elapsedMs: 16_000}, 10_000)).toEqual({fraction: 0.1, elapsedMs: 5_000});
  });

  it('starts over when the set of replaying sub-wallets changes', () => {
    const rate = new ProgressRateTracker();
    rate.observe('shielded+dust', {fraction: 0.001, elapsedMs: 0});
    expect(rate.observe('shielded+dust', {fraction: 0.002, elapsedMs: 60_000})).toEqual({fraction: 0.001, elapsedMs: 0});
    expect(rate.observe('dust', {fraction: 0.01, elapsedMs: 150_000})).toBeUndefined();
    expect(rate.observe('dust', {fraction: 0.05, elapsedMs: 160_000})).toEqual({fraction: 0.01, elapsedMs: 150_000});
  });

  it('keeps the two newest samples through a stall longer than the window', () => {
    const rate = new ProgressRateTracker();
    rate.observe(phase, {fraction: 0.1, elapsedMs: 0}, 10_000);
    rate.observe(phase, {fraction: 0.2, elapsedMs: 5_000}, 10_000);
    // Nothing for a minute, then one more: the 5s sample is kept so the stall
    // reads as a slow rate rather than as no rate at all.
    expect(rate.observe(phase, {fraction: 0.21, elapsedMs: 65_000}, 10_000)).toEqual({fraction: 0.2, elapsedMs: 5_000});
  });
});
