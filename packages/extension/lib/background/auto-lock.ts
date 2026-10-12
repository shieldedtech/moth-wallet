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
const USER_ACTIVITY_KEY = 'session.lastUserActivityAt';

/**
 * How many auto-lock windows a connected dApp's own requests can keep the wallet
 * unlocked for without the user touching the panel or resolving an approval.
 * A dApp in use should not lock mid-session, but polling must not keep it open forever.
 */
export const DAPP_ACTIVITY_CEILING = 4;

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

/**
 * Pure expiry test. Never expires in demo mode or before any activity. Expires
 * once the window passes with no activity at all, or once the user has done
 * nothing for `DAPP_ACTIVITY_CEILING` windows, however busy a dApp has been.
 */
export function isAutoLockExpired(
  lastActivityAt: number | null,
  autoLockMinutes: number | null,
  now: number,
  lastUserActivityAt: number | null = null,
): boolean {
  if (autoLockMinutes === null || autoLockMinutes <= 0) return false;
  if (lastActivityAt === null) return false;
  const windowMs = autoLockMinutes * 60_000;
  if (now - lastActivityAt >= windowMs) return true;
  return lastUserActivityAt !== null && now - lastUserActivityAt >= windowMs * DAPP_ACTIVITY_CEILING;
}

function sessionStore(): Browser.storage.StorageArea {
  return browser.storage.session as Browser.storage.StorageArea;
}

/** Record activity. A dApp's own requests pass `{ byUser: false }`, so they
 *  extend the session only up to the ceiling. */
export async function recordActivity(now: number, { byUser = true }: { byUser?: boolean } = {}): Promise<void> {
  const entries: Record<string, number> = { [ACTIVITY_KEY]: now };
  if (byUser) entries[USER_ACTIVITY_KEY] = now;
  await sessionStore().set(entries);
}

export async function getLastActivity(): Promise<number | null> {
  const stored = await sessionStore().get(ACTIVITY_KEY);
  const value = stored[ACTIVITY_KEY];
  return typeof value === 'number' ? value : null;
}

export async function getLastUserActivity(): Promise<number | null> {
  const stored = await sessionStore().get(USER_ACTIVITY_KEY);
  const value = stored[USER_ACTIVITY_KEY];
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
