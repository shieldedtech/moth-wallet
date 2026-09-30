import { describe, expect, it } from 'vitest';
import {
  CNIGHT_FINALITY_SECONDS,
  describeCountdown,
  finalityCountdown,
} from '../../../src/cardano/finality.js';
import { coinPublicKeyFromShieldedAddress } from '../../../src/cardano/registration.js';

describe('CNIGHT_FINALITY_SECONDS', () => {
  it('is Cardano k=2160 at ~20s a block — the 12 hours users see', () => {
    // Pinned because the whole countdown is wrong if this drifts, and the
    // number is the one thing here nobody can derive from the code.
    expect(CNIGHT_FINALITY_SECONDS).toBe(43_200);
    expect(CNIGHT_FINALITY_SECONDS / 3600).toBe(12);
  });
});

describe('finalityCountdown', () => {
  const confirmed = 1_700_000_000;

  it('counts down from confirmation, not from now', () => {
    // Two hours in: ten to go. Starting the clock at "now" would restart the
    // wait on every device that looked at it.
    const c = finalityCountdown(confirmed, (confirmed + 7_200) * 1000);
    expect(c.generatingFrom).toBe(confirmed + CNIGHT_FINALITY_SECONDS);
    expect(c.secondsRemaining).toBe(CNIGHT_FINALITY_SECONDS - 7_200);
    expect(c.elapsed).toBe(false);
  });

  it('floors at zero rather than going negative once the wait is over', () => {
    const c = finalityCountdown(confirmed, (confirmed + CNIGHT_FINALITY_SECONDS + 999) * 1000);
    expect(c.secondsRemaining).toBe(0);
    expect(c.elapsed).toBe(true);
  });
});

describe('describeCountdown', () => {
  it('is coarse above an hour and precise below', () => {
    expect(describeCountdown(CNIGHT_FINALITY_SECONDS)).toBe('12h 0m');
    expect(describeCountdown(11 * 3600 + 43 * 60)).toBe('11h 43m');
    expect(describeCountdown(90)).toBe('1m');
    expect(describeCountdown(30)).toBe('30s');
  });

  it('never shows a negative or zero wait as a duration', () => {
    expect(describeCountdown(0)).toBe('any moment now');
    expect(describeCountdown(-5)).toBe('any moment now');
  });
});

describe('coinPublicKeyFromShieldedAddress', () => {
  // The published test-vector account used across these tests.
  const SHIELDED =
    'mn_shield-addr1ehmxwu6u7vz8wjs5ddm0e409hk7p7kud3gz5e6v3p0xqj44wderqrpwkgz4zhffyx47k0tv9qudcd6qxh7vmgjsjt00ah88hltw3pucuz795u';

  it('recovers the same coin public key the seed derives', () => {
    // This is what lets a locked account be offered as a DUST receiver: the
    // public address alone is enough, no unlock required.
    expect(coinPublicKeyFromShieldedAddress(SHIELDED)).toBe(
      'cdf667735cf304774a146b76fcd5e5bdbc1f5b8d8a054ce9910bcc0956ae6e46',
    );
  });

  it('refuses an address that is not shielded', () => {
    // A DUST or night address decodes fine but holds a different key, and
    // registering it would send DUST somewhere unspendable.
    expect(() =>
      coinPublicKeyFromShieldedAddress(
        'mn_dust_preview1wdfagtl9j990yv8qdk8ezgwqtumlp977s00885wd6rmvsnngzlt9xjp8mfe',
      ),
    ).toThrow(/shielded address/);
  });

  it('refuses something that is not an address at all', () => {
    expect(() => coinPublicKeyFromShieldedAddress('not-an-address')).toThrow();
  });
});
