import {describe, expect, it} from 'vitest';
import {overallSyncProgress} from '../../../src/sync/progress.js';

// A part whose progress reads {0, 0} used to count as complete: right for a
// sub-wallet with nothing relevant to apply, and wrong for one whose slice was
// missing from an emission, which made the TUI alternate about once a second
// between the real figures and "synced · 0 / 0" with no balance. It now counts
// only once the sub-wallet says it is complete, and is then left out of the
// average.
describe('a sub-wallet reading 0/0', () => {
  it('is left out of the average once it is complete', () => {
    const r = overallSyncProgress({
      shielded: {applied: 1_452_313, total: 1_452_313},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 91_475, total: 1_453_091},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: false,
      synced: false, elapsedMs: 1_000,
    });
    expect(r.slowest).toBe('dust');
    expect(r.percentage).toBeCloseTo((1 + 91_475 / 1_453_091) / 2, 5);
  });

  it('counts for nothing while it has not said it is complete', () => {
    const r = overallSyncProgress({
      shielded: {applied: 1_452_313, total: 1_452_313},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 91_475, total: 1_453_091},
      shieldedSynced: true, unshieldedSynced: false, dustSynced: false,
      synced: false, elapsedMs: 1_000,
    });
    expect(r.slowest).toBe('unshielded');
    expect(r.percentage).toBeCloseTo((1 + 0 + 91_475 / 1_453_091) / 3, 5);
  });

  it('a part that is genuinely 0/0 still counts as complete, not stalled', () => {
    // A fresh wallet's unshielded progress is legitimately 0/0, and must not drag
    // the overall figure to zero.
    const r = overallSyncProgress({
      shielded: {applied: 10, total: 10},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 10, total: 10},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: true,
      synced: true, elapsedMs: 1_000,
    });
    expect(r.percentage).toBe(1);
  });
});
