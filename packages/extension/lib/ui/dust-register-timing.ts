// How long a NIGHT coin has sat unregistered before the register flow warns
// about it.
//
// Grounded in observed evidence, not theory (docs/bugs-found.md-style report
// filed upstream against a devnet defect): every registration known to
// succeed on this class of devnet registered its coin within seconds of
// funding — 10+ times, with no failures. Every documented chain-wide wedge
// involved a coin that had sat unregistered for 22 seconds or longer, up to
// 39 minutes. Neither coin size nor delay alone explains the pattern, but
// "fund, then register immediately" is the only pattern with zero known
// failures — so that's what this warns toward, without claiming to know why.
export const STALE_UNREGISTERED_MS = 60_000;

export interface UnregisteredCoinAge {
  /** Age of the oldest unregistered, unbooked NIGHT coin, in ms — null if
   *  there is none, or none report a creation time. */
  oldestMs: number | null;
}

/** The oldest unregistered coin's age among `rows`. Booked coins (reserved by
 *  a pending transaction) are excluded — they cannot be registered yet, so
 *  their age is not actionable. */
export function oldestUnregisteredCoinAge(
  rows: readonly { registered: boolean; booked: boolean; ctimeMs: number | null }[],
  now: number = Date.now(),
): UnregisteredCoinAge {
  let oldestMs: number | null = null;
  for (const row of rows) {
    if (row.registered || row.booked || row.ctimeMs === null) continue;
    const age = now - row.ctimeMs;
    if (oldestMs === null || age > oldestMs) oldestMs = age;
  }
  return { oldestMs };
}

/** Whether the register flow should warn: the oldest unregistered coin has
 *  been sitting long enough that immediate registration is no longer what
 *  is about to happen. */
export function isStaleUnregistered(age: UnregisteredCoinAge, thresholdMs: number = STALE_UNREGISTERED_MS): boolean {
  return age.oldestMs !== null && age.oldestMs >= thresholdMs;
}
