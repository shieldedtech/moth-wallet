/**
 * Parsing a NIGHT amount typed by a human.
 *
 * One definition, because the repo had four and they disagreed. `moth transfer`
 * used `parseFloat` and `Math.round`, which accepts what it cannot understand and
 * keeps the prefix: `1,5` became 1 NIGHT rather than an error, `1abc` became 1,
 * `1e3` became 1000, and `0.0000001` rounded to zero base units and was submitted
 * as a transfer of nothing (#63). `daemon transfer` already did this correctly
 * with a strict pattern and BigInt arithmetic; this is that logic, shared.
 *
 * Money never goes through a float. A NIGHT decimal is exact in base units, and
 * `Number` cannot represent every value it needs to.
 */

/** Base units — STARS — per whole NIGHT. */
export const STARS_PER_NIGHT = 1_000_000n;

/** The most fractional digits a NIGHT amount can carry: one STAR. */
export const NIGHT_DECIMALS = 6;

export class InvalidAmountError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid amount "${input}": ${reason}`);
    this.name = 'InvalidAmountError';
  }
}

/**
 * Convert a decimal NIGHT string to base units.
 *
 * Rejects rather than reinterprets. Anything beyond `^\d+(\.\d{1,6})?$` is an
 * error, including scientific notation, thousands separators, trailing text and
 * more than six fractional digits — a silently rounded seventh digit is a
 * different amount from the one that was typed.
 *
 * Zero is refused too: it passes every arithmetic check and produces a
 * transaction that moves nothing while still paying a fee.
 */
export function parseNightAmount(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidAmountError(input, 'no amount given');

  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new InvalidAmountError(
      input,
      'expected a plain decimal such as "1" or "1.5" — no exponents, separators or units',
    );
  }

  const [, whole, frac] = match;
  if (frac !== undefined && frac.length > NIGHT_DECIMALS) {
    throw new InvalidAmountError(
      input,
      `NIGHT has ${NIGHT_DECIMALS} decimal places; "${frac}" has ${frac.length}`,
    );
  }

  const base = BigInt(whole) * STARS_PER_NIGHT + BigInt((frac ?? '').padEnd(NIGHT_DECIMALS, '0') || '0');
  if (base === 0n) throw new InvalidAmountError(input, 'amount is zero');
  return base;
}

/** Render base units back as a NIGHT decimal, trailing zeros trimmed. */
export function formatNightAmount(base: bigint): string {
  const whole = base / STARS_PER_NIGHT;
  const frac = (base % STARS_PER_NIGHT).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}
