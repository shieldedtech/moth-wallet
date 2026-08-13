// Pure formatting helpers for wallet balances. Shared between the TUI
// (for dashboard rendering) and the daemon handlers (for L3 modal
// summaries).
//
// Midnight denominations:
//   1 NIGHT = 10^6 STAR  (the smallest NIGHT unit)
//   1 DUST  = 10^15 SPECK (the smallest DUST unit; DUST is non-transferable)
// All other (contract-issued) tokens have no protocol-level decimals and
// are displayed as raw integers.

/** STAR per NIGHT: 1 NIGHT = 10^6 STAR. */
export const NIGHT_DENOMINATION: bigint = BigInt(10 ** 6);

/** SPECK per DUST: 1 DUST = 10^15 SPECK. */
export const DUST_DENOMINATION: bigint = BigInt(10 ** 15);

/**
 * Generic balance formatter. Divides by the supplied denomination and
 * applies decimal-place + scale-suffix (K/M/B/T) formatting.
 */
export function formatBalance(balance: bigint, denomination: bigint = NIGHT_DENOMINATION): string {
  const value = balance / denomination;
  const fractionalPart = balance % denomination;

  const trillion = 1_000_000_000_000n;
  const billion = 1_000_000_000n;
  const million = 1_000_000n;

  if (value >= trillion) return formatScaled(value, fractionalPart, trillion, 'T');
  if (value >= billion) return formatScaled(value, fractionalPart, billion, 'B');
  if (value >= million) return formatScaled(value, fractionalPart, million, 'M');

  const wholeStr = value.toLocaleString('en-US');
  if (fractionalPart > 0n) {
    const fractionalStr = fractionalPart.toString().padStart(6, '0').replace(/0+$/, '');
    return `${wholeStr}.${fractionalStr}`;
  }
  return wholeStr;
}

function formatScaled(value: bigint, fractionalPart: bigint, scale: bigint, suffix: string): string {
  const whole = value / scale;
  const remainder = value % scale;
  const decimalPart = Number((remainder * 100n) / scale);
  if (decimalPart === 0 && fractionalPart === 0n) {
    return `${whole.toLocaleString('en-US')}${suffix}`;
  }
  const decimalStr = (decimalPart / 100).toFixed(2).substring(1).replace(/\.?0+$/, '');
  return `${whole.toLocaleString('en-US')}${decimalStr}${suffix}`;
}

/** SPECK → DUST display. 1 DUST = 10^15 SPECK. */
export function formatDustBalance(speckBalance: bigint): string {
  return formatBalance(speckBalance, DUST_DENOMINATION);
}
