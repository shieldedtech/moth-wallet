// Overall sync progress must track the slowest sub-wallet.
//
// Regression for a wallet that reported "100% (0s remaining)" while dust sat at
// 178,029 of 1,395,558 events with roughly 69 minutes of work left. The figure
// came from shielded indices alone, on the assumption that shielded was the
// slowest sub-wallet — it is not; dust is, by two orders of magnitude.

import {describe, expect, it} from 'vitest';
import {overallSyncProgress} from '../../../src/sync/progress.js';

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
