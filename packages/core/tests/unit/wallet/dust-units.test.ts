import {describe, it, expect} from 'vitest';
import {formatBalance, formatDustBalance, NIGHT_DENOMINATION} from '../../../src/wallet/balance-format.js';
import {formatNight} from '../../../src/types/tokens.js';

// DUST is denominated in SPECKS (10^15 per DUST); NIGHT in STARS (10^6).
// wallet-sync's synced line applied formatNight to a DUST balance, so every
// DUST figure it ever logged was wrong by a factor of 10^9 — and looked
// entirely plausible, which is why it survived so long.
describe('DUST and NIGHT denominations are not interchangeable', () => {
  it('formats one whole DUST as 1', () => {
    expect(formatDustBalance(1_000_000_000_000_000n)).toBe('1');
  });

  it('formats one whole NIGHT as 1.000000', () => {
    expect(formatNight(1_000_000n)).toBe('1.000000');
  });

  it('disagrees by 10^9 on the same input, so one cannot stand in for the other', () => {
    // The measured preview balance from the proving check: 36,292,129,999
    // specks is a small fraction of a DUST, but formatNight renders it as
    // "36292.129999" — a plausible-looking number that is nine orders out.
    const specks = 36_292_129_999n;
    expect(formatNight(specks)).toBe('36292.129999');
    expect(formatDustBalance(specks)).not.toBe(formatNight(specks));
    expect(Number(formatNight(specks))).toBeGreaterThan(1_000);
  });
});

describe('fractional padding follows the denomination', () => {
  // Regression for #97 (7): formatBalance padded the fraction to 6 digits
  // regardless of denomination, dropping the leading zeros of a DUST fraction
  // and overstating it by ~100x.
  it('pads a DUST fraction to 15 digits, not 6', () => {
    expect(formatDustBalance(41004319999999999n)).toBe('41.004319999999999');
  });

  it('still trims trailing zeros', () => {
    // 41.004 DUST exactly: the fraction pads to 15 then trims the tail.
    expect(formatDustBalance(41_004_000_000_000_000n)).toBe('41.004');
  });

  it('leaves a whole DUST amount without a fraction', () => {
    expect(formatDustBalance(1_000_000_000_000_000n)).toBe('1');
  });

  it('does not change NIGHT, whose denomination is 10^6', () => {
    expect(formatBalance(1_500_000n, NIGHT_DENOMINATION)).toBe('1.5');
    expect(formatBalance(5_000_000_000n, NIGHT_DENOMINATION)).toBe('5,000');
  });
});
