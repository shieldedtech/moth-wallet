import { describe, expect, it } from 'vitest';
import { activityRetryDelayMs } from '../lib/ui/client';

// A failed feed read on a synced, idle wallet has no other trigger to fall back
// on, so the hook retries on its own: quickly at first, then backing off.
describe('activityRetryDelayMs', () => {
  it('retries after a second on the first failure', () => {
    expect(activityRetryDelayMs(1)).toBe(1_000);
  });

  it('doubles on each further failure', () => {
    expect(activityRetryDelayMs(2)).toBe(2_000);
    expect(activityRetryDelayMs(3)).toBe(4_000);
    expect(activityRetryDelayMs(4)).toBe(8_000);
  });

  it('caps the wait at thirty seconds', () => {
    expect(activityRetryDelayMs(6)).toBe(30_000);
    expect(activityRetryDelayMs(40)).toBe(30_000);
  });

  it('never waits less than a second', () => {
    expect(activityRetryDelayMs(0)).toBe(1_000);
  });
});
