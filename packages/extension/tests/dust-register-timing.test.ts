import { describe, expect, it } from 'vitest';
import { STALE_UNREGISTERED_MS, isStaleUnregistered, oldestUnregisteredCoinAge } from '../lib/ui/dust-register-timing';

const NOW = 1_800_000_000_000;

function coin(overrides: Partial<{ registered: boolean; booked: boolean; ctimeMs: number | null }> = {}) {
  return { registered: false, booked: false, ctimeMs: NOW, ...overrides };
}

describe('oldestUnregisteredCoinAge', () => {
  it('reports null when there are no coins', () => {
    expect(oldestUnregisteredCoinAge([], NOW)).toEqual({ oldestMs: null });
  });

  it('reports null when every coin is registered', () => {
    expect(oldestUnregisteredCoinAge([coin({ registered: true })], NOW)).toEqual({ oldestMs: null });
  });

  it('excludes booked coins — they cannot be registered yet, so their age is not actionable', () => {
    expect(oldestUnregisteredCoinAge([coin({ booked: true, ctimeMs: NOW - 10_000 })], NOW)).toEqual({
      oldestMs: null,
    });
  });

  it('excludes coins with no known creation time', () => {
    expect(oldestUnregisteredCoinAge([coin({ ctimeMs: null })], NOW)).toEqual({ oldestMs: null });
  });

  it('computes the age of a single unregistered coin', () => {
    expect(oldestUnregisteredCoinAge([coin({ ctimeMs: NOW - 5_000 })], NOW)).toEqual({ oldestMs: 5_000 });
  });

  it('takes the OLDEST among several unregistered coins, not the newest or a sum', () => {
    const rows = [coin({ ctimeMs: NOW - 1_000 }), coin({ ctimeMs: NOW - 90_000 }), coin({ ctimeMs: NOW - 30_000 })];
    expect(oldestUnregisteredCoinAge(rows, NOW)).toEqual({ oldestMs: 90_000 });
  });

  it('ignores registered/booked coins even when they are older than the unregistered ones', () => {
    const rows = [
      coin({ registered: true, ctimeMs: NOW - 10_000_000 }),
      coin({ booked: true, ctimeMs: NOW - 5_000_000 }),
      coin({ ctimeMs: NOW - 2_000 }),
    ];
    expect(oldestUnregisteredCoinAge(rows, NOW)).toEqual({ oldestMs: 2_000 });
  });
});

describe('isStaleUnregistered', () => {
  it('is false below the threshold', () => {
    expect(isStaleUnregistered({ oldestMs: STALE_UNREGISTERED_MS - 1 })).toBe(false);
  });

  it('is true at and above the threshold', () => {
    expect(isStaleUnregistered({ oldestMs: STALE_UNREGISTERED_MS })).toBe(true);
    expect(isStaleUnregistered({ oldestMs: STALE_UNREGISTERED_MS + 1 })).toBe(true);
  });

  it('is false when there is nothing to warn about', () => {
    expect(isStaleUnregistered({ oldestMs: null })).toBe(false);
  });

  it('honors a caller-supplied threshold', () => {
    expect(isStaleUnregistered({ oldestMs: 5_000 }, 10_000)).toBe(false);
    expect(isStaleUnregistered({ oldestMs: 15_000 }, 10_000)).toBe(true);
  });
});
