import { describe, expect, it } from 'vitest';
import { isAutoLockExpired, syncHoldsAutoLock, SYNC_HOLD_MAX_MS, SYNC_STALL_MS } from '../lib/background/auto-lock';

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

// A sync the user is watching defers the lock — but only while it progresses and never
// past a hard cap, and without touching the clock. An unbounded hold would keep key
// material resident for as long as a sync failed to finish.
describe('syncHoldsAutoLock', () => {
  const watching = { panelOpen: true, syncActive: true, synced: false as boolean | null, lastProgressAt: NOW, holdSince: null as number | null, now: NOW };

  it('holds while a panel is open on a progressing engine that is not yet synced', () => {
    expect(syncHoldsAutoLock(watching)).toBe(true);
    // No balances yet — still restoring caches — counts as not synced; the start is progress.
    expect(syncHoldsAutoLock({ ...watching, synced: null })).toBe(true);
  });

  it('releases once the engine reports synced', () => {
    expect(syncHoldsAutoLock({ ...watching, synced: true })).toBe(false);
  });

  it('never holds an unattended wallet: no panel, or no engine running', () => {
    expect(syncHoldsAutoLock({ ...watching, panelOpen: false })).toBe(false);
    expect(syncHoldsAutoLock({ ...watching, syncActive: false })).toBe(false);
  });

  it('releases a sync that has stopped making progress', () => {
    expect(syncHoldsAutoLock({ ...watching, lastProgressAt: NOW - SYNC_STALL_MS + 1 })).toBe(true);
    expect(syncHoldsAutoLock({ ...watching, lastProgressAt: NOW - SYNC_STALL_MS })).toBe(false);
    expect(syncHoldsAutoLock({ ...watching, lastProgressAt: null })).toBe(false);
  });

  it('releases once the hold has run for the cap, progress or not', () => {
    expect(syncHoldsAutoLock({ ...watching, holdSince: NOW - SYNC_HOLD_MAX_MS + 1 })).toBe(true);
    expect(syncHoldsAutoLock({ ...watching, holdSince: NOW - SYNC_HOLD_MAX_MS })).toBe(false);
  });
});
