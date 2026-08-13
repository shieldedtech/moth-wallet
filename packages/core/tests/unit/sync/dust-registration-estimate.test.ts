import {describe, it, expect} from 'vitest';
import {
  estimateRegistrationAffordability,
  type DustGenerationSlice,
} from '../../../src/sync/dust-registration-estimate.js';

const SPECKS_PER_DUST = 1_000_000_000_000_000n;
const STARS_PER_NIGHT = 1_000_000n;
const DECAY_RATE = 8_267n;
const NIGHT_DUST_RATIO = 5n * (SPECKS_PER_DUST / STARS_PER_NIGHT);

/** A UTxO holding `night` NIGHT that has existed for `ageSeconds`, using the
 *  ledger's own arithmetic so the fixtures cannot drift from the protocol. */
const utxo = (night: bigint, ageSeconds: bigint, registered = false): DustGenerationSlice => {
  const stars = night * STARS_PER_NIGHT;
  const rate = stars * DECAY_RATE;
  const maxCap = stars * NIGHT_DUST_RATIO;
  const generatedNow = ageSeconds * rate;
  return {
    generatedNow: generatedNow > maxCap ? maxCap : generatedNow,
    rate,
    maxCap,
    registeredForDustGeneration: registered,
  };
};

describe('estimateRegistrationAffordability', () => {
  const fee = 300_000_000_000_001n; // 0.3 DUST, the figure observed on preprod

  it('reports the wait rather than just refusing', () => {
    // The reported failure: 0.0639 DUST backdated against a 0.3 DUST fee.
    const estimate = estimateRegistrationAffordability(fee, [utxo(1n, 7_730n)]);
    expect(estimate.affordable).toBe(false);
    expect(estimate.available).toBe(63_903_910_000_000n);
    // ~10.1 hours from funding, so ~7.9 hours still to go.
    expect(estimate.secondsUntilAffordable).toBe(28_559);
  });

  it('scales the wait down as the holding grows', () => {
    // Same fee, same freshly-funded wallet, three orders of magnitude of NIGHT.
    const wait = (night: bigint) =>
      estimateRegistrationAffordability(fee, [utxo(night, 0n)]).secondsUntilAffordable;
    expect(wait(1n)).toBe(36_289); // ~10 hours
    expect(wait(10n)).toBe(3_629); // ~1 hour
    expect(wait(100n)).toBe(363); // ~6 minutes
    expect(wait(1_000n)).toBe(37); // ~36 seconds
  });

  it('is affordable once the backdated amount covers the fee', () => {
    const estimate = estimateRegistrationAffordability(fee, [utxo(1_000n, 60n)]);
    expect(estimate.affordable).toBe(true);
    expect(estimate.secondsUntilAffordable).toBe(0);
  });

  it('never reports affordable a second early', () => {
    // At exactly the fee it is payable; one second's accrual short it is not,
    // and the wait must be a full second rather than a rounded-down zero.
    const rate = 1_000n * STARS_PER_NIGHT * DECAY_RATE;
    const justShort: DustGenerationSlice = {...utxo(1_000n, 0n), generatedNow: fee - 1n};
    const exact: DustGenerationSlice = {...utxo(1_000n, 0n), generatedNow: fee};
    expect(estimateRegistrationAffordability(fee, [exact]).affordable).toBe(true);
    const short = estimateRegistrationAffordability(fee, [justShort]);
    expect(short.affordable).toBe(false);
    expect(short.secondsUntilAffordable).toBe(1);
    expect(short.rate).toBe(rate);
  });

  it('says "unreachable" rather than a wait when the holding tops out too low', () => {
    // 0.05 NIGHT can only ever back 0.25 DUST, below a 0.3 DUST fee. Waiting is
    // the wrong advice; more NIGHT is the only route.
    const stars = 50_000n; // 0.05 NIGHT in stars
    const tiny: DustGenerationSlice = {
      generatedNow: 0n,
      rate: stars * DECAY_RATE,
      maxCap: stars * NIGHT_DUST_RATIO,
      registeredForDustGeneration: false,
    };
    const estimate = estimateRegistrationAffordability(fee, [tiny]);
    expect(estimate.maxAvailable).toBeLessThan(fee);
    expect(estimate.secondsUntilAffordable).toBeNull();
  });

  it('ignores NIGHT that is already backing DUST', () => {
    // The ledger's generationless filter: registered UTxOs contribute nothing to
    // a backdated fee payment, however long they have existed. A wallet whose
    // NIGHT is entirely registered has no accrual to wait on at all.
    const estimate = estimateRegistrationAffordability(fee, [utxo(1_000n, 86_400n, true)]);
    expect(estimate.available).toBe(0n);
    expect(estimate.rate).toBe(0n);
    expect(estimate.secondsUntilAffordable).toBeNull();
  });

  it('pools eligible UTxOs', () => {
    // Registration draws on every unregistered UTxO at once, so two small ones
    // reach the fee at the same point one of twice the size would.
    const split = estimateRegistrationAffordability(fee, [utxo(50n, 0n), utxo(50n, 0n)]);
    const whole = estimateRegistrationAffordability(fee, [utxo(100n, 0n)]);
    expect(split.secondsUntilAffordable).toBe(whole.secondsUntilAffordable);
  });

  it('treats a zero fee as payable', () => {
    // Re-registration cedes no fee payment; nothing to wait for.
    expect(estimateRegistrationAffordability(0n, [utxo(1n, 0n)]).affordable).toBe(true);
  });
});
