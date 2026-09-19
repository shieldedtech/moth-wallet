import {describe, expect, it} from 'vitest';
import {
  formatNightAmount,
  InvalidAmountError,
  parseNightAmount,
  STARS_PER_NIGHT,
} from '../../../src/wallet/night-amount.js';

describe('parseNightAmount', () => {
  it('converts whole and fractional NIGHT exactly', () => {
    expect(parseNightAmount('1')).toBe(STARS_PER_NIGHT);
    expect(parseNightAmount('1.5')).toBe(1_500_000n);
    expect(parseNightAmount('0.000001')).toBe(1n);
    expect(parseNightAmount(' 2 ')).toBe(2_000_000n);
  });

  // #63. Each of these was ACCEPTED as a different amount by the parseFloat
  // version, with no warning. The first two are money bugs rather than cosmetic:
  // a comma decimal is a plausible input across most of Europe and lost a third
  // of the value, and a sub-STAR amount rounded to zero and was submitted as a
  // transfer of nothing that still paid a fee.
  it.each([
    ['1,5', 'comma decimal, previously sent 1 NIGHT instead of 1.5'],
    ['0.0000001', 'below one STAR, previously rounded to a zero transfer'],
    ['1e3', 'scientific notation, previously sent 1000 NIGHT'],
    ['1abc', 'trailing text, previously sent 1 NIGHT'],
    ['1.2345678', 'seven decimals, previously rounded silently'],
    ['', 'empty'],
    ['-1', 'negative'],
    ['abc', 'not a number'],
    ['0', 'zero moves nothing and still pays a fee'],
  ])('refuses %j — %s', (input) => {
    expect(() => parseNightAmount(input)).toThrow(InvalidAmountError);
  });

  it('says what is wrong, not just that something is', () => {
    expect(() => parseNightAmount('1.2345678')).toThrow(/6 decimal places/);
    expect(() => parseNightAmount('1e3')).toThrow(/no exponents/);
  });

  it('round-trips through formatNightAmount', () => {
    for (const value of ['1', '1.5', '0.000001', '123456.789012']) {
      expect(formatNightAmount(parseNightAmount(value))).toBe(value);
    }
  });
});
