import { describe, expect, it } from 'vitest';
import { DAPP_ACTIVITY_CEILING, isAutoLockExpired } from '../lib/background/auto-lock';

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

  // A polling dApp once kept the wallet unlocked forever (#204). Its requests
  // still extend the session (#162), but only up to the ceiling.
  it('locks once the user has been away for the ceiling, however busy a dApp is', () => {
    const recent = NOW - 1 * MIN;
    expect(isAutoLockExpired(recent, 15, NOW, NOW - (15 * DAPP_ACTIVITY_CEILING - 1) * MIN)).toBe(false);
    expect(isAutoLockExpired(recent, 15, NOW, NOW - 15 * DAPP_ACTIVITY_CEILING * MIN)).toBe(true);
  });

  it('ignores the ceiling before any user activity is recorded, and in demo mode', () => {
    expect(isAutoLockExpired(NOW - 1 * MIN, 15, NOW, null)).toBe(false);
    expect(isAutoLockExpired(NOW - 1 * MIN, null, NOW, NOW - 100 * 60 * MIN)).toBe(false);
  });
});
