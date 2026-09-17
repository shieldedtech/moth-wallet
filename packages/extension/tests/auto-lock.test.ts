import { describe, expect, it } from 'vitest';
import { isAutoLockExpired, syncHoldsAutoLock } from '../lib/background/auto-lock';

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

// A sync the user is watching is activity — locking a panel left open on a long
// first sync kills the engine and greets the user with a password prompt.
describe('syncHoldsAutoLock', () => {
  it('holds while a panel is open on a running engine that is not yet synced', () => {
    expect(syncHoldsAutoLock(true, true, false)).toBe(true);
    // No balances yet — still restoring caches — counts as not synced.
    expect(syncHoldsAutoLock(true, true, null)).toBe(true);
  });

  it('releases once the engine reports synced', () => {
    expect(syncHoldsAutoLock(true, true, true)).toBe(false);
  });

  it('never holds an unattended wallet: no panel, or no engine running', () => {
    expect(syncHoldsAutoLock(false, true, false)).toBe(false);
    expect(syncHoldsAutoLock(true, false, false)).toBe(false);
    expect(syncHoldsAutoLock(false, false, null)).toBe(false);
  });
});
