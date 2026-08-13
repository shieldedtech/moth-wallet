import {describe, it, expect} from 'vitest';
import {formatDustBalance} from '../../../src/wallet/balance-format.js';
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
