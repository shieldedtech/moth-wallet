import { describe, it, expect } from 'vitest';
import {
  accountLabel,
  formatDust,
  formatDustFee,
  formatAmount,
  formatNightAmount,
  formatTokenBalance,
  parseAmount,
} from '../lib/ui/format';

describe('accountLabel', () => {
  it('prefers the user-set label', () => {
    expect(accountLabel('Account-1', 'Savings')).toBe('Savings');
  });

  it('falls back to the formatted storage name when the label is empty or missing', () => {
    expect(accountLabel('Account-1')).toBe('Account 1');
    expect(accountLabel('Account-1', '   ')).toBe('Account 1');
    expect(accountLabel('Sable', undefined)).toBe('Sable');
  });
});

// 1 DUST = 10^15 SPECK (Midnight glossary). The bug this guards against was
// formatting DUST through the NIGHT formatter (10^6), reading 10^9 too large.
const DUST = 10n ** 15n;

describe('formatDust (SPECK -> DUST)', () => {
  it('uses the 10^15 DUST denomination, not NIGHT 10^6', () => {
    // 10,000 DUST — the value that previously rendered as 10,000,000,000,000.
    expect(formatDust(10_000n * DUST)).toBe('10,000');
    // Raw SPECK for 10,000 DUST is 10^19; the NIGHT formatter would show 10^13.
    expect(formatDust(10n ** 19n)).toBe('10,000');
  });

  it('groups thousands', () => {
    expect(formatDust(12_345n * DUST)).toBe('12,345');
  });

  it('keeps up to two decimals, stripping trailing zeros', () => {
    expect(formatDust(0n)).toBe('0');
    expect(formatDust(DUST)).toBe('1');
    expect(formatDust(DUST / 2n)).toBe('0.5');
    expect(formatDust(DUST + DUST / 100n)).toBe('1.01');
  });

  it('truncates below display precision instead of rounding up', () => {
    // 1.000000000000001 DUST -> "1", never "1.01" or "2".
    expect(formatDust(DUST + 1n)).toBe('1');
  });

  it('abbreviates millions, billions and trillions', () => {
    expect(formatDust(5_000_000n * DUST)).toBe('5M');
    expect(formatDust(12_500_000n * DUST)).toBe('12.5M');
    expect(formatDust(3_000_000_000n * DUST)).toBe('3B');
    expect(formatDust(1_200_000_000_000n * DUST)).toBe('1.2T');
  });
});

describe('formatDustFee', () => {
  const DUST = 10n ** 15n;

  it('keeps useful precision for estimated fees', () => {
    expect(formatDustFee(DUST / 8n)).toBe('0.125');
    expect(formatDustFee(DUST + DUST / 10_000n)).toBe('1.0001');
  });

  it('never presents a non-zero fee as zero', () => {
    expect(formatDustFee(1n)).toBe('< 0.000001');
    expect(formatDustFee(0n)).toBe('0');
  });
});

describe('formatTokenBalance (display balances)', () => {
  const NIGHT = 10n ** 6n;

  it('shows a whole balance as a whole number, not a padded fraction', () => {
    // The behaviour this replaces rendered a 120 NIGHT balance as "120.000000".
    expect(formatTokenBalance(120n * NIGHT, 6)).toBe('120');
    expect(formatTokenBalance(0n, 6)).toBe('0');
  });

  it('keeps decimals when the balance actually has them', () => {
    expect(formatTokenBalance(120n * NIGHT + NIGHT / 2n, 6)).toBe('120.5');
    expect(formatTokenBalance(NIGHT + NIGHT / 4n, 6)).toBe('1.25');
  });

  it('keeps full precision for sub-unit balances', () => {
    // A single STAR must stay visible rather than rounding away to "0".
    expect(formatTokenBalance(1n, 6)).toBe('0.000001');
    expect(formatTokenBalance(10n, 6)).toBe('0.00001');
  });

  it('groups thousands', () => {
    expect(formatTokenBalance(12_345n * NIGHT, 6)).toBe('12,345');
    expect(formatTokenBalance(12_345n * NIGHT + NIGHT / 2n, 6)).toBe('12,345.5');
  });

  it('never abbreviates, so a large balance stays exact', () => {
    // The DUST gauge collapses these to "5M"/"1.2T"; a balance must not, or a
    // holder cannot tell 5,000,000 from 5,099,999.
    expect(formatTokenBalance(5_000_000n * NIGHT, 6)).toBe('5,000,000');
    expect(formatTokenBalance(5_099_999n * NIGHT, 6)).toBe('5,099,999');
    expect(formatTokenBalance(1_200_000_000_000n * NIGHT, 6)).toBe('1,200,000,000,000');
  });

  it('groups native tokens (0 decimals) without inventing a fraction', () => {
    expect(formatTokenBalance(5n, 0)).toBe('5');
    expect(formatTokenBalance(1_000_000n, 0)).toBe('1,000,000');
  });

  // BigInt `%` keeps the sign of its left operand, so deriving the fraction from
  // `raw % unit` put the minus after the decimal point: -1.5 read "-1.-5" and
  // -0.5 read "0.-5". Balances are normally non-negative, but this is the
  // balance formatter for several screens, so it must not emit nonsense.
  it('puts the sign in front of a negative amount', () => {
    expect(formatTokenBalance(-(NIGHT + NIGHT / 2n), 6)).toBe('-1.5');
    expect(formatTokenBalance(-(NIGHT / 2n), 6)).toBe('-0.5');
    expect(formatTokenBalance(-120n * NIGHT, 6)).toBe('-120');
    expect(formatTokenBalance(-12_345n, 0)).toBe('-12,345');
  });
});

describe('formatDust and formatNightAmount share the sign handling', () => {
  // formatUnits is shared, so the sign fix has to hold for the abbreviating
  // callers too — `whole % scale` had the same problem in the suffix branch.
  it('signs negative DUST and NIGHT amounts, including abbreviated ones', () => {
    expect(formatDust(-(DUST + DUST / 2n))).toBe('-1.5');
    expect(formatNightAmount(-1_500_000n)).toBe('-1.5');
    expect(formatNightAmount(-12_500_000n * 10n ** 6n)).toBe('-12.5M');
  });
});

describe('formatAmount / parseAmount (per-token decimals)', () => {
  it('keeps native tokens (0 decimals) as-is, never formatting them as NIGHT', () => {
    // The bug: a raw balance of 5 must read as "5", not NIGHT's "0.000005".
    expect(formatAmount(5n, 0)).toBe('5');
    expect(formatAmount(1_000_000n, 0)).toBe('1000000');
    expect(formatAmount(0n, 0)).toBe('0');
  });

  it('formats NIGHT (6 decimals) with the fractional part', () => {
    expect(formatAmount(5_000_000n, 6)).toBe('5.000000');
    expect(formatAmount(1_500_000n, 6)).toBe('1.500000');
  });

  it('parses native-token amounts as raw integers and rejects decimals', () => {
    // Typing "5" for a 0-decimal token must send 5 units, not 5,000,000.
    expect(parseAmount('5', 0)).toBe(5n);
    expect(parseAmount('1000000', 0)).toBe(1_000_000n);
    expect(() => parseAmount('1.5', 0)).toThrow();
  });

  it('parses NIGHT amounts by scaling to 6 decimals', () => {
    expect(parseAmount('5', 6)).toBe(5_000_000n);
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
    expect(() => parseAmount('1.1234567', 6)).toThrow();
  });
});
