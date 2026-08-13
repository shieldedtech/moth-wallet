// Token amount formatting/parsing for the UI. Amounts are integer base units:
//   NIGHT — 6 decimals  (1 NIGHT = 10^6 STAR);  formatNight in core divides by 1e6.
//   DUST  — 15 decimals (1 DUST  = 10^15 SPECK; Midnight glossary).
// DUST base units are 10^9 times finer than NIGHT's, so DUST must never be run
// through the NIGHT formatter — it would read a billion times too large.

import { t } from '../i18n';

const DECIMALS = 6n;

const DUST_UNIT = 10n ** 15n;

/**
 * Format a DUST balance (raw SPECK) for display: thousands-grouped with up to
 * two decimals, abbreviating millions and up (12.5M, 3B, 1.2T) so the value
 * stays short enough for the ring gauge and cards regardless of magnitude.
 */
export function formatDust(raw: bigint): string {
  return formatUnits(raw, DUST_UNIT, 2);
}

/**
 * Format an estimated network fee without rounding a small non-zero fee down
 * to zero. Fees get up to six decimals; sub-micro-DUST values use a clear
 * lower-bound label instead of a misleading `0`.
 */
export function formatDustFee(raw: bigint): string {
  if (raw === 0n) return '0';
  const microDust = DUST_UNIT / 1_000_000n;
  if (raw > 0n && raw < microDust) return '< 0.000001';
  const whole = raw / DUST_UNIT;
  return formatUnits(raw, DUST_UNIT, whole >= 1_000n ? 2 : whole >= 1n ? 4 : 6);
}

// Shared integer-unit formatter. `unit` is base units per whole token; the
// decimals come from `unit` (not a hard-coded 6) so it's correct for any token.
// `abbreviateLarge` collapses millions and up to "12.5M"; callers showing an
// exact balance turn it off, since that suffix hides up to 99,999 whole tokens.
function formatUnits(raw: bigint, unit: bigint, maxDecimals: number, abbreviateLarge = true): string {
  // Format the magnitude and carry the sign. The fraction below is derived from
  // `raw % unit`, which in BigInt arithmetic keeps the sign of `raw`, so a
  // negative amount would otherwise put the minus after the decimal point:
  // -1.5 rendered as "-1.-5", and -0.5 as "0.-5". The abbreviation branch has
  // the same problem via `whole % scale`.
  if (raw < 0n) return `-${formatUnits(-raw, unit, maxDecimals, abbreviateLarge)}`;

  const whole = raw / unit;

  const million = 1_000_000n;
  const billion = 1_000_000_000n;
  const trillion = 1_000_000_000_000n;
  if (abbreviateLarge) {
    if (whole >= trillion) return abbreviate(whole, trillion, 'T');
    if (whole >= billion) return abbreviate(whole, billion, 'B');
    if (whole >= million) return abbreviate(whole, million, 'M');
  }

  const scaled = ((raw % unit) * 10n ** BigInt(maxDecimals)) / unit;
  const fraction = scaled.toString().padStart(maxDecimals, '0').replace(/0+$/, '');
  const grouped = whole.toLocaleString('en-US');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

// One-decimal magnitude suffix, e.g. 12_500_000 -> "12.5M" (truncated, not rounded).
function abbreviate(whole: bigint, scale: bigint, suffix: string): string {
  const q = whole / scale;
  const tenths = ((whole % scale) * 10n) / scale;
  return tenths > 0n
    ? `${q.toLocaleString('en-US')}.${tenths}${suffix}`
    : `${q.toLocaleString('en-US')}${suffix}`;
}

/**
 * Format a NIGHT amount for list rows (activity): thousands-grouped with
 * trailing zeros trimmed, so a whole 120 reads "120", while sub-unit amounts
 * keep their precision. Rows abbreviate large magnitudes to stay compact;
 * balances use formatTokenBalance, which stays exact.
 */
export function formatNightAmount(raw: bigint): string {
  return formatUnits(raw, 10n ** DECIMALS, Number(DECIMALS));
}

/**
 * Format a token balance for display: thousands-grouped, trailing fractional
 * zeros trimmed, never abbreviated. A whole 120 NIGHT reads "120" rather than
 * "120.000000", while 120.5 keeps its decimals and sub-unit balances keep all
 * six places — trimming zeros off a fixed-decimal token loses nothing. Unlike
 * the DUST gauge this never collapses to "1.2M": a balance the holder is
 * reading off must stay exact.
 *
 * `decimals` is the token's base-unit exponent (NIGHT is 6); 0 — native tokens,
 * whose wallet values are already whole units — just groups the integer.
 * A balance is normally non-negative, but a negative amount formats with the
 * sign in front rather than producing nonsense, since this is the entry point
 * for balances on several screens.
 */
export function formatTokenBalance(raw: bigint, decimals: number): string {
  const places = Math.max(decimals, 0);
  return formatUnits(raw, 10n ** BigInt(places), places, false);
}

/**
 * Format a raw token amount as a plain, ungrouped decimal string — the inverse
 * of parseAmount, for text the user edits or that gets parsed back. Displayed
 * balances use formatTokenBalance instead; the thousands separators here would
 * make an amount field unparseable.
 *
 * `decimals` is the token's base-unit exponent: NIGHT is 6. Native tokens (any
 * non-NIGHT, non-DUST token) are kept as-is — pass 0 to show the raw integer
 * rather than running it through a decimal formatter that would misread it 10^6
 * too small. DUST has its own denomination via formatDust.
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const major = raw / unit;
  const minor = raw % unit;
  return `${major}.${String(minor).padStart(decimals, '0')}`;
}

/**
 * Parse a user-entered amount into raw base units for a token with `decimals`
 * places. decimals <= 0 (native tokens) accepts raw integers only.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (decimals <= 0) {
    if (!/^\d+$/.test(trimmed)) throw new Error(t('formatErrors_wholeNumber'));
    return BigInt(trimmed);
  }
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    throw new Error(t('formatErrors_positiveNumber'));
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(t('formatErrors_maxDecimals', [decimals]));
  }
  const unit = 10n ** BigInt(decimals);
  return BigInt(whole) * unit + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Parse a user-entered decimal NIGHT amount into raw units. */
export function parseNight(input: string): bigint {
  return parseAmount(input, Number(DECIMALS));
}

/** Wallet names must match [a-zA-Z0-9_-]+ (they key the keystore in storage),
    so setup stores auto-created accounts as "Account-1" and the UI shows
    "Account 1". Other names pass through untouched. */
export function displayName(name: string): string {
  return name.replace(/^Account-(\d+)$/, 'Account $1');
}

/** User-facing account name: the user-set label when present, otherwise the
    storage name via displayName. */
export function accountLabel(name: string, label?: string): string {
  return label?.trim() || displayName(name);
}
