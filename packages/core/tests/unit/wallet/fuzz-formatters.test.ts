import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatNight } from '../../../src/types/tokens.js';

describe('token formatters', () => {
  it('round-trips arbitrary non-negative NIGHT balances', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (raw) => {
        const [major, minor] = formatNight(raw).split('.');
        expect(BigInt(major) * 1_000_000n + BigInt(minor)).toBe(raw);
      }),
      { numRuns: 250 },
    );
  });
});
