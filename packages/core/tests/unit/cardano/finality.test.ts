import { describe, expect, it } from 'vitest';
import {
  CNIGHT_FINALITY_SECONDS,
  describeCountdown,
  finalityCountdown,
} from '../../../src/cardano/finality.js';
import { dustAddressBytes } from '../../../src/cardano/registration.js';

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

describe('dustAddressBytes', () => {
  const DUST =
    'mn_dust_preprod1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyh4t0ey';

  it('serializes to the 33 bytes a registration datum records', () => {
    // Confirmed against the wallet SDK: DustAddress.serialize() is exactly the
    // bech32m payload, 33 bytes.
    expect(dustAddressBytes(DUST)).toBe(
      '738d7ea6be572e69fd7d6f943d86f4521a1ca7ddf1160f1d93c820a86712692422',
    );
  });

  it('is network-agnostic — the same key on preview and preprod', () => {
    // Only the prefix and checksum differ between networks; the payload is the
    // key itself, which is why a registration made on one reads correctly on
    // the other.
    const preview =
      'mn_dust_preview1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyktmuyy';
    expect(dustAddressBytes(preview)).toBe(dustAddressBytes(DUST));
  });

  it('refuses a shielded address by name', () => {
    expect(() =>
      dustAddressBytes(
        'mn_shield-addr1ehmxwu6u7vz8wjs5ddm0e409hk7p7kud3gz5e6v3p0xqj44wderqrpwkgz4zhffyx47k0tv9qudcd6qxh7vmgjsjt00ah88hltw3pucuz795u',
      ),
    ).toThrow(/DUST address/);
  });

  it('refuses something that is not an address at all', () => {
    expect(() => dustAddressBytes('not-an-address')).toThrow();
  });
});
