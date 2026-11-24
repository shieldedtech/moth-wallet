// Overall sync progress must track the slowest sub-wallet.
//
// Regression for a wallet that reported "100% (0s remaining)" while dust sat at
// 178,029 of 1,395,558 events with roughly 69 minutes of work left. The figure
// came from shielded indices alone, on the assumption that shielded was the
// slowest sub-wallet — it is not; dust is, by two orders of magnitude.

import {describe, expect, it} from 'vitest';
import {dustProgressFor, overallSyncProgress} from '../../../src/sync/progress.js';

const complete = {applied: 1_395_558, total: 1_395_558};

describe('overallSyncProgress', () => {
  it('counts DUST, not only shielded', () => {
    // The exact state observed on preprod: shielded and unshielded done, dust 12%.
    // Unshielded is empty, so the figure is the average of shielded and DUST.
    const {percentage, slowest} = overallSyncProgress({
      shielded: complete,
      unshielded: {applied: 0, total: 0},
      dust: {applied: 178_029, total: 1_395_558},
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 600_000,
    });

    expect(Math.round(percentage * 100)).toBe(56); // was 100
    expect(slowest).toBe('dust');
  });

  it('estimates the remaining time from the sub-wallet that is behind', () => {
    // 10 minutes in at ~12.8% implies well over an hour left, not 0s.
    const {etaSeconds} = overallSyncProgress({
      shielded: complete,
      unshielded: {applied: 0, total: 0},
      dust: {applied: 178_029, total: 1_395_558},
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 600_000,
    });

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

  it('leaves a sub-wallet with nothing to sync out of the average', () => {
    // A fresh wallet's unshielded progress is legitimately 0/0, and strictly
    // complete once connected. Counting that as zero would peg the whole wallet
    // at 0% forever; counting it as a third of the bar would hand out progress
    // nobody made.
    const {percentage} = overallSyncProgress({
      shielded: {applied: 500, total: 1000},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 750, total: 1000},
      shieldedSynced: false,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 10_000,
    });

    expect(percentage).toBeCloseTo(0.625, 5);
  });

  it('moves with every sub-wallet, not only the slowest', () => {
    // A pre-seeded new wallet on preprod: shielded catching up from the
    // reference, unshielded not yet complete, the DUST pass at its start. Taking
    // the slowest read 0% here, then 100%.
    const {percentage, slowest} = overallSyncProgress({
      shielded: {applied: 1_982_194, total: 2_020_895},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 0, total: 3_499_403},
      shieldedSynced: false,
      unshieldedSynced: false,
      dustSynced: false,
      synced: false,
      elapsedMs: 1_400,
    });

    expect(Math.round(percentage * 100)).toBe(33);
    expect(slowest).toBe('unshielded');
  });

  it('does not read sub-wallets that have not reported yet as complete', () => {
    // Before connecting, every part reads 0/0 and none is strictly complete.
    // This showed 99% with 0s remaining for the first seconds of a fresh preprod
    // sync, then fell to 0%.
    const silent = {applied: 0, total: 0};
    const r = overallSyncProgress({
      shielded: silent,
      unshielded: silent,
      dust: silent,
      shieldedSynced: false,
      unshieldedSynced: false,
      dustSynced: false,
      synced: false,
      elapsedMs: 33_000,
    });

    expect(r.percentage).toBe(0);
    expect(r.etaSeconds).toBeNull();
  });

  it('does not count a connected, complete empty part as the whole wallet', () => {
    // Unshielded on a fresh wallet finishes first, while the others have yet to
    // report: still 0%, not 99%.
    const silent = {applied: 0, total: 0};
    const {percentage} = overallSyncProgress({
      shielded: silent,
      unshielded: silent,
      dust: silent,
      shieldedSynced: false,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 35_000,
    });

    expect(percentage).toBe(0);
  });

  it('omits an estimate before there is enough signal', () => {
    const {etaSeconds} = overallSyncProgress({
      shielded: {applied: 1, total: 1_000_000},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 1, total: 1_000_000},
      shieldedSynced: false,
      unshieldedSynced: true,
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
    expect(r.slowestFraction).toBeCloseTo(0.3, 5);
    expect(Math.round(r.percentage * 100)).toBe(77);
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

  it('reports the fraction of the sub-wallet it names', () => {
    // The estimate is measured against this fraction, so it must be the named
    // sub-wallet's own and not the average.
    const r = overallSyncProgress({...base, dust: {applied: 42, total: 100}});
    expect(r.slowest).toBe('dust');
    expect(r.slowestFraction).toBeCloseTo(0.42, 5);
  });
});

describe('ETA on a resumed sync', () => {
  const at = (fraction: number, elapsedMs: number, baseline?: {fraction: number; elapsedMs: number}) =>
    overallSyncProgress({
      shielded: {applied: 1, total: 1},
      unshielded: {applied: 1, total: 1},
      dust: {applied: Math.round(fraction * 1_000_000), total: 1_000_000},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: false,
      synced: false, elapsedMs, baseline,
    });

  // The bug, in the numbers it produced on preprod. A run that restored dust at
  // ~65% and then ran 152s was read as "67% in 152s" — 15x the real rate — so it
  // promised 1m15s against a true ~10m, and the estimate CLIMBED as elapsed time
  // corrected the fiction: 2m23s by the time it reached 81%.
  it('no longer reads resumed progress as this session\'s work', () => {
    const baseline = {fraction: 0.65, elapsedMs: 0};
    const early = at(0.67, 152_000, baseline);
    const later = at(0.81, 622_000, baseline);
    // 2 points in 152s → 33 points remaining ≈ 2500s. Nothing like 75s.
    expect(early.etaSeconds).toBeGreaterThan(1_000);
    // An honest estimate FALLS as the run proceeds; the broken one rose.
    expect(later.etaSeconds!).toBeLessThan(early.etaSeconds!);
  });

  it('measures the rate over this session only', () => {
    // 10 points in 100s → 0.1 points/s → 50 points left → 500s.
    const eta = at(0.5, 100_000, {fraction: 0.4, elapsedMs: 0}).etaSeconds;
    expect(eta).toBe(500);
  });

  it('accounts for a baseline captured after the clock started', () => {
    // Baseline at 20s/40%, now 120s/60%: 20 points in 100s → 40 left → 200s.
    expect(at(0.6, 120_000, {fraction: 0.4, elapsedMs: 20_000}).etaSeconds).toBe(200);
  });

  it('says nothing rather than guessing before there is movement to measure', () => {
    expect(at(0.4001, 1_500, {fraction: 0.4, elapsedMs: 0}).etaSeconds).toBeNull();
    expect(at(0.4, 60_000, {fraction: 0.4, elapsedMs: 0}).etaSeconds).toBeNull();
  });

  it('keeps the whole-run estimate when there is no baseline yet', () => {
    // A sync that genuinely starts at zero has nothing to measure from on its
    // first sample, so the old assumption is still the best available.
    expect(at(0.5, 100_000).etaSeconds).toBe(100);
  });

  it('is 0 once synced, baseline or not', () => {
    const r = overallSyncProgress({
      shielded: {applied: 1, total: 1}, unshielded: {applied: 1, total: 1}, dust: {applied: 1, total: 1},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: true,
      synced: true, elapsedMs: 5_000, baseline: {fraction: 0.9, elapsedMs: 0},
    });
    expect(r.etaSeconds).toBe(0);
  });
});

// A projections pass applies nothing to the wallet until it ends, so the wallet
// reports no DUST total while one runs. The pass's own position stands in.
describe('dustProgressFor', () => {
  const silent = {applied: 0, total: 0};

  it('shows the pass position while the wallet reports no total', () => {
    expect(dustProgressFor(silent, {resolvedThrough: 3_400_000, tip: 3_500_000})).toEqual({
      applied: 3_400_000,
      total: 3_500_000,
    });
  });

  it('replaces a cursor left without a total, such as the one a hand-over parks', () => {
    expect(dustProgressFor({applied: 1_623_186, total: 0}, {resolvedThrough: 0, tip: 3_500_000})).toEqual({
      applied: 0,
      total: 3_500_000,
    });
  });

  it("keeps the wallet's own figures once it reports a total", () => {
    const reported = {applied: 700, total: 752_061};
    expect(dustProgressFor(reported, {resolvedThrough: 3_400_000, tip: 3_500_000})).toBe(reported);
  });

  it('reports nothing new before a pass has said where it is', () => {
    expect(dustProgressFor(silent, null)).toBe(silent);
    expect(dustProgressFor(silent, {resolvedThrough: 0, tip: 0})).toBe(silent);
  });

  it('never shows a position beyond the tip', () => {
    expect(dustProgressFor(silent, {resolvedThrough: 120, tip: 100})).toEqual({applied: 100, total: 100});
  });

  it('feeds the overall figure, so a running pass no longer reads as 99%', () => {
    const {percentage, slowest} = overallSyncProgress({
      shielded: complete,
      unshielded: silent,
      dust: dustProgressFor(silent, {resolvedThrough: 1_750_000, tip: 3_500_000}),
      shieldedSynced: true,
      unshieldedSynced: true,
      dustSynced: false,
      synced: false,
      elapsedMs: 60_000,
    });
    expect(slowest).toBe('dust');
    expect(percentage).toBeCloseTo(0.75, 5); // shielded done, DUST pass halfway
  });
});
