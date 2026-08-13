import { describe, expect, it } from 'vitest';
import { isAutoLockExpired } from '../lib/background/auto-lock';

const NOW = Date.parse('2026-07-17T12:00:00Z');
const MIN = 60_000;

describe('isAutoLockExpired', () => {
  it('expires once the inactivity window has elapsed', () => {
    expect(isAutoLockExpired(NOW - 15 * MIN, 15, NOW)).toBe(true);
    expect(isAutoLockExpired(NOW - 16 * MIN, 15, NOW)).toBe(true);
  });

  it('stays unlocked before the window elapses', () => {
    expect(isAutoLockExpired(NOW - 14 * MIN, 15, NOW)).toBe(false);
    expect(isAutoLockExpired(NOW, 15, NOW)).toBe(false);
  });

  it('never expires in demo mode (null) or with a non-positive window', () => {
    expect(isAutoLockExpired(NOW - 10 * 60 * MIN, null, NOW)).toBe(false);
    expect(isAutoLockExpired(NOW - 10 * 60 * MIN, 0, NOW)).toBe(false);
  });

  it('never expires before any activity is recorded', () => {
    expect(isAutoLockExpired(null, 15, NOW)).toBe(false);
  });

  it('treats the boundary as expired (>=)', () => {
    expect(isAutoLockExpired(NOW - 1 * MIN, 1, NOW)).toBe(true);
  });
});
