import {describe, expect, it} from 'vitest';
import {overallSyncProgress} from '../../../src/sync/progress.js';

// The rendering consequence, isolated. A part whose progress reads {0, 0} is
// treated as COMPLETE by fraction(), which is correct for a sub-wallet with
// nothing relevant to apply and catastrophic for one whose slice was simply
// missing from an emission: the TUI alternated about once a second between the
// real figures and "synced · 0 / 0" with no balance.
describe('a zeroed sub-wallet reads as complete', () => {
  it('reports 100% when a part reports 0/0, which is why zeroing one is dangerous', () => {
    const r = overallSyncProgress({
      shielded: {applied: 1_452_313, total: 1_452_313},
      unshielded: {applied: 0, total: 0},
      dust: {applied: 91_475, total: 1_453_091},
      shieldedSynced: true, unshieldedSynced: true, dustSynced: false,
      synced: false, elapsedMs: 1_000,
    });
    // dust is the constraint, and correctly so — but unshielded at 0/0 was
    // counted as done rather than unknown.
    expect(r.slowest).toBe('dust');
    expect(r.percentage).toBeCloseTo(91_475 / 1_453_091, 5);
  });

  it('a part that is genuinely 0/0 still counts as complete, not stalled', () => {
    // A fresh wallet's unshielded progress is legitimately 0/0, and must not drag
    // the overall figure to zero. This is the behaviour the carry-forward has to
    // preserve while still fixing the flash.
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
