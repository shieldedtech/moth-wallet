// Inactivity auto-lock. The panel reports activity (mount + throttled input);
// a periodic alarm wakes the service worker to check whether the configured
// window has elapsed and, if so, locks (handlers.enforceAutoLock). Demo mode
// (autoLockMinutes === null) never expires and clears the alarm entirely.
//
// The alarm is the reliable timer for an MV3 service worker (setTimeout dies
// with the worker; alarms wake it). `lastActivityAt` lives in storage.session
// so it shares the unlocked session's lifecycle — memory-backed, cleared when
// the browser exits, surviving SW restarts in between.

import { browser, type Browser } from 'wxt/browser';

export const AUTO_LOCK_ALARM = 'auto-lock-check';
const ACTIVITY_KEY = 'session.lastActivityAt';

// One minute is Chrome's practical minimum period and gives coarse-but-fine
// granularity for a security timeout (worst case ~1 min late).
const CHECK_PERIOD_MINUTES = 1;

/** Options offered in Settings. `null` is demo mode (never locks). */
export const AUTO_LOCK_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: null, label: 'Never (demo mode)' },
];

/** Pure expiry test. Never expires in demo mode or before any activity. */
export function isAutoLockExpired(
  lastActivityAt: number | null,
  autoLockMinutes: number | null,
  now: number,
): boolean {
  if (autoLockMinutes === null || autoLockMinutes <= 0) return false;
  if (lastActivityAt === null) return false;
  return now - lastActivityAt >= autoLockMinutes * 60_000;
}

function sessionStore(): Browser.storage.StorageArea {
  return browser.storage.session as Browser.storage.StorageArea;
}

export async function recordActivity(now: number): Promise<void> {
  await sessionStore().set({ [ACTIVITY_KEY]: now });
}

export async function getLastActivity(): Promise<number | null> {
  const stored = await sessionStore().get(ACTIVITY_KEY);
  const value = stored[ACTIVITY_KEY];
  return typeof value === 'number' ? value : null;
}

/** Arm (or, for demo mode, clear) the periodic check alarm. Idempotent. */
export function armAutoLock(autoLockMinutes: number | null): void {
  if (autoLockMinutes === null || autoLockMinutes <= 0) {
    void browser.alarms.clear(AUTO_LOCK_ALARM);
    return;
  }
  browser.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
}

export function clearAutoLock(): void {
  void browser.alarms.clear(AUTO_LOCK_ALARM);
}
