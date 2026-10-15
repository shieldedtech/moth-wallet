import { describe, expect, it } from 'vitest';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet';
import { parseAmount } from '../../src/screens/send.js';

const night = (input: string) => parseAmount(input, 'unshielded', NIGHT_TOKEN_ID);

describe('Send parseAmount (NIGHT)', () => {
  it('converts a NIGHT decimal to STARS', () => {
    expect(night('1.25')).toEqual({ ok: true, raw: 1_250_000n });
    expect(night('5')).toEqual({ ok: true, raw: 5_000_000n });
  });

  // The local parser sliced the seventh digit off, so the amount sent was not
  // the amount typed.
  it('rejects more than six decimals instead of truncating', () => {
    expect(night('0.0000001').ok).toBe(false);
    expect(night('1.1234567').ok).toBe(false);
  });

  it('rejects zero, empty and non-decimal input', () => {
    expect(night('0').ok).toBe(false);
    expect(night('').ok).toBe(false);
    expect(night('1e3').ok).toBe(false);
    expect(night('1,5').ok).toBe(false);
  });
});

describe('Send parseAmount (custom token)', () => {
  const custom = (input: string) => parseAmount(input, 'shielded', NIGHT_TOKEN_ID);

  it('takes whole raw units only', () => {
    expect(custom('7')).toEqual({ ok: true, raw: 7n });
    expect(custom('1.5').ok).toBe(false);
  });
});
