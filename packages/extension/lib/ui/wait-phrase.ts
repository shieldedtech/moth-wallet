// A localizable "how long to wait" phrase.
//
// Core computes waits in seconds (see sync/dust-registration-estimate.ts). The
// panel cannot render a raw count: 28559 means nothing, and a translated string
// cannot be assembled by concatenating a number onto a word — grammar varies.
// So this picks the message key and its argument, and the caller translates.
//
// Deliberately coarse, and coarser as the wait grows. Every one of these
// estimates assumes the wallet's holdings do not change, so "about 8 hours"
// states the uncertainty honestly where "7h 55m 12s" would imply precision the
// figure does not have.
//
// Pure and dependency-free, so the boundaries are unit-testable without a
// renderer or a locale.

import type { MessageKey } from '../i18n';

export interface WaitPhrase {
  key: MessageKey;
  args?: string[];
}

export function waitPhrase(seconds: number): WaitPhrase {
  // Never "0 seconds": the caller only asks when there is something to wait for,
  // and a sub-second wait rounding to zero reads as a bug.
  if (seconds < 60) return { key: 'dust_waitSeconds', args: [String(Math.max(1, Math.round(seconds)))] };
  if (seconds < 3_600) return { key: 'dust_waitMinutes', args: [String(Math.round(seconds / 60))] };
  if (seconds < 5_400) return { key: 'dust_waitHour' }; // 1h–1.5h reads better as "an hour"
  if (seconds < 86_400) return { key: 'dust_waitHours', args: [String(Math.round(seconds / 3_600))] };
  return { key: 'dust_waitDays', args: [String(Math.max(1, Math.round(seconds / 86_400)))] };
}
