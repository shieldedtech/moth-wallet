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
    // 10 points in 100s → 0.1 points/s → 50 points left → 500s, shown with
    // the 1.5x margin as 750s.
    const rate = new ProgressRateTracker();
    dustAlone(0.4, 0, rate);
    expect(dustAlone(0.5, 100_000, rate).etaSeconds).toBe(750);
  });

  it('accounts for a first sample taken after the clock started', () => {
    // First sample at 20s/40%, now 120s/60%: 20 points in 100s → 40 left →
    // 200s, shown as 300s with the margin.
    const rate = new ProgressRateTracker();
    dustAlone(0.4, 20_000, rate);
    expect(dustAlone(0.6, 120_000, rate).etaSeconds).toBe(300);
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
    expect(dustAlone(14_870 / 185_388, 174_000, rate).etaSeconds).toBeNull();
    const eta = dustAlone(30_000 / 185_388, 189_000, rate).etaSeconds!;
    // 21,567 events in 30s → ~155,000 left → ~215s, shown as ~325s with the
    // margin. The whole-session rate (30,000 in 189s) would have said ~980s.
    expect(eta).toBeGreaterThan(300);
    expect(eta).toBeLessThan(400);
  });

  it('measures over a window, so an early slow stretch stops weighing on it once it leaves', () => {
    const rate = new ProgressRateTracker();
    dustAlone(0.01, 0, rate);
    // A slow stretch: 1 point in 100s would be ~9,900s remaining.
    dustAlone(0.02, 100_000, rate);
    // Then 0.2 points per second.
    let before: number | null = null;
    for (let t = 130_000, f = 0.08; t <= 250_000; t += 30_000, f += 0.06) before = dustAlone(f, t, rate).etaSeconds;
    // While the slow stretch is still inside the three-minute window the
    // slowest bin is that stretch, and the estimate stays huge.
    expect(before!).toBeGreaterThan(1_000);
    // The first sample after it has left: 62 points at 0.2/s → 310s, ×1.5 → 465s.
    const after = dustAlone(0.38, 280_000, rate).etaSeconds!;
    expect(after).toBeLessThan(500);
  });

  // The DUST-only phase of a real mainnet sync, sampled every 30s: dust events
  // applied out of 185,390, with the seconds that were actually left. The walk
  // arrives in bursts (t+214s carried 55k events; its neighbours ~10-15k), and
  // the slope between window endpoints read those bursts as the trend: the
  // display went 106s, 94, 81, then back UP to 148, 164, 169 while the bar
  // barely moved. A countdown is only believable if it counts down.
  const MAINNET_DUST_PHASE: Array<[elapsedS: number, applied: number, actualLeftS: number]> = [
    [154, 12_807, 363], [184, 26_837, 333], [214, 82_550, 303], [244, 97_411, 273],
    [274, 110_894, 243], [304, 120_432, 213], [334, 128_765, 183], [364, 136_512, 153],
    [394, 145_350, 123], [424, 155_121, 93], [454, 165_442, 63], [484, 175_608, 33], [514, 184_538, 3],
  ];

  it('counts down monotonically through a bursty DUST walk', () => {
    const rate = new ProgressRateTracker();
    const shown = MAINNET_DUST_PHASE.map(([s, applied]) => dustAlone(applied / 185_390, s * 1000, rate).etaSeconds);
    // The first sample of the phase has nothing to measure from.
    expect(shown[0]).toBeNull();
    const numbers = shown.slice(1) as number[];
    numbers.forEach((n) => expect(n).not.toBeNull());
    // Never goes back up.
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]!).toBeLessThanOrEqual(numbers[i - 1]!);
    // And converges: within a minute of the truth over the second half.
    const half = Math.floor(MAINNET_DUST_PHASE.length / 2);
    for (let i = half; i < MAINNET_DUST_PHASE.length; i++) {
      expect(Math.abs(shown[i]! - MAINNET_DUST_PHASE[i]![2])).toBeLessThan(60);
    }
  });

  // Seen on a mainnet wallet: the countdown ran to 1 min, then jumped to 5.
  // Near the end the DUST walk reaches the chain tip and new events arrive at
  // block pace, so the measured rate collapses — but nothing is being
  // replayed any more, and a raise there announces minutes of work that do
  // not exist.
  it('never raises the estimate at the chain tip, and hides it once the promise runs out', () => {
    const rate = new ProgressRateTracker();
    // A steady walk: 2 points per 30s, promising ~45s (×1.5) at 97%.
    for (let t = 0, f = 0.91; f <= 0.97 + 1e-9; t += 30_000, f += 0.02) dustAlone(f, t, rate);
    const promised = dustAlone(0.98, 120_000, rate).etaSeconds!;
    expect(promised).toBeGreaterThan(0);
    // Then a crawl at the tip: 0.1 point per 30s would read as 10 minutes.
    const shown: Array<number | null> = [];
    for (let t = 150_000, f = 0.981; t <= 330_000; t += 30_000, f += 0.001) shown.push(dustAlone(f, t, rate).etaSeconds);
    const numbers = shown.filter((n): n is number => n !== null);
    // Counts down from the promise…
    expect(numbers[0]!).toBeLessThan(promised);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]!).toBeLessThanOrEqual(numbers[i - 1]!);
    // …and is hidden, never raised, once the promise has run out.
    expect(shown.at(-1)).toBeNull();
    expect(Math.max(...numbers)).toBeLessThan(promised);
  });

  it('re-estimates upward only when the pace clearly collapsed, and only once it persisted', () => {
    const rate = new ProgressRateTracker();
    // Fast: 1 point per second → from 10% that promises 90s.
    dustAlone(0.10, 0, rate);
    dustAlone(0.25, 15_000, rate);
    const promised = dustAlone(0.40, 30_000, rate).etaSeconds!;
    expect(promised).toBeLessThanOrEqual(100);
    // Then a crawl: 0.1 point per second. For the first 30s the display keeps
    // counting down what it promised…
    const during = dustAlone(0.41, 40_000, rate).etaSeconds!;
    expect(during).toBeLessThan(promised);
    // …and once the collapse has held long enough it is allowed to say so.
    let after: number | null = null;
    for (let t = 50_000, f = 0.42; t <= 120_000; t += 10_000, f += 0.01) after = dustAlone(f, t, rate).etaSeconds;
    expect(after!).toBeGreaterThan(during);
  });
});

describe('ProgressRateTracker', () => {
  const phase = 'dust';
  const at = (fraction: number, elapsedMs: number) => ({fraction, elapsedMs});

  it('has nothing to say on the first sample of a phase, or before a whole bin has passed', () => {
    const rate = new ProgressRateTracker();
    expect(rate.observe(phase, at(0.1, 0))).toBeNull();
    expect(rate.observe(phase, at(0.2, 10_000))).toBeNull();
    expect(rate.observe(phase, at(0.25, 15_000))).toBeNull();
    // 30s of samples is a rate: 0.2 per 30s → 0.7 left → 105s, ×1.5 → 158s.
    expect(rate.observe(phase, at(0.3, 30_000))).toBe(158);
  });

  it('uses the slowest bin, so one burst does not become the trend', () => {
    const steady = new ProgressRateTracker();
    const bursty = new ProgressRateTracker();
    for (let t = 0, f = 0; t <= 60_000; t += 10_000, f += 0.05) steady.observe(phase, at(f, t));
    // Same samples, except one interval carries ten times the movement.
    const burstFractions = [0, 0.05, 0.10, 0.60, 0.65, 0.70, 0.75];
    let burstEta: number | null = null;
    burstFractions.forEach((f, i) => { burstEta = bursty.observe(phase, at(f, i * 10_000)); });
    const steadyEta = steady.observe(phase, at(0.35, 70_000));
    // Steady: 0.05/10s → 0.65 left → 130s, ×1.5 → 195s. Bursty at 75%: 0.25
    // left at the slow bin's rate → 50s raw, not the ~12s the burst-inflated
    // slope would say.
    expect(steadyEta).toBe(195);
    expect(burstEta!).toBeGreaterThan(40);
  });

  it('starts over when the set of replaying sub-wallets changes', () => {
    const rate = new ProgressRateTracker();
    rate.observe('shielded+dust', at(0.001, 0));
    expect(rate.observe('shielded+dust', at(0.002, 60_000))).not.toBeNull();
    expect(rate.observe('dust', at(0.01, 150_000))).toBeNull();
    expect(rate.observe('dust', at(0.02, 160_000))).toBeNull();
    expect(rate.observe('dust', at(0.05, 180_000))).not.toBeNull();
  });

  it('keeps counting down through a stall rather than inventing a rate from nothing', () => {
    const rate = new ProgressRateTracker();
    rate.observe(phase, at(0.1, 0));
    rate.observe(phase, at(0.2, 15_000));
    const promised = rate.observe(phase, at(0.3, 30_000))!;
    // No movement for a while: the deadline keeps approaching.
    const stalled = rate.observe(phase, at(0.3, 50_000))!;
    expect(stalled).toBe(promised - 20);
  });
});
