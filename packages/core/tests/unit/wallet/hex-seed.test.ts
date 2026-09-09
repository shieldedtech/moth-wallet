// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {describe, it, expect} from 'vitest';
import {
  checkHexSeed,
  assertHexSeed,
  CANONICAL_SEED_BYTES,
  MAX_SEED_BYTES,
  MIN_SEED_BYTES,
} from '../../../src/wallet/hex-seed.js';
import {deriveAllAddressesFromSeed} from '../../../src/wallet/address.js';

const hex = (bytes: number) => 'ab'.repeat(bytes);

describe('hex seed shape checks', () => {
  it('accepts the two lengths real tooling emits', () => {
    for (const bytes of CANONICAL_SEED_BYTES) {
      const check = checkHexSeed(hex(bytes));
      expect(check).toMatchObject({ok: true, bytes, unusualLength: false});
    }
  });

  it('accepts but flags a length no tool produces', () => {
    // Valid to the SDK, so refusing it would lock out a wallet genuinely made
    // at this length. Flagged, because a truncated paste looks exactly like it.
    expect(checkHexSeed(hex(31))).toMatchObject({ok: true, bytes: 31, unusualLength: true});
  });

  it('rejects malformed input with a reason the UI can localise', () => {
    expect(checkHexSeed('')).toMatchObject({ok: false, problem: 'empty'});
    expect(checkHexSeed('not hex at all!!')).toMatchObject({ok: false, problem: 'not-hex'});
    // Hex-ness is checked before length, so an all-hex odd string reports the
    // missing character rather than blaming the alphabet.
    expect(checkHexSeed('abc')).toMatchObject({ok: false, problem: 'odd-length'});
    expect(checkHexSeed('a'.repeat(65))).toMatchObject({ok: false, problem: 'odd-length'});
    expect(checkHexSeed(hex(15))).toMatchObject({ok: false, problem: 'too-short', bytes: 15});
    expect(checkHexSeed(hex(65))).toMatchObject({ok: false, problem: 'too-long', bytes: 65});
  });

  it('ignores surrounding whitespace, which a paste routinely carries', () => {
    expect(checkHexSeed(`  ${hex(32)}\n`).ok).toBe(true);
    expect(assertHexSeed(`  ${hex(32)}\n`)).toBe(hex(32));
  });

  it('throws INVALID_INPUT rather than letting the SDK say "Invalid seed"', () => {
    expect(() => assertHexSeed('zz')).toThrowError(/hexadecimal/i);
    expect(() => assertHexSeed(hex(65))).toThrowError(/too long/i);
  });
});

// The bounds are not a house style — they are what the SDK's HDWallet.fromSeed
// actually accepts. If a wallet-sdk bump moves them, these fail rather than the
// UI quietly refusing seeds that work (or accepting ones that do not).
describe('bounds match what the SDK accepts', () => {
  it('derives at both ends of the accepted range', () => {
    expect(() => deriveAllAddressesFromSeed(hex(MIN_SEED_BYTES))).not.toThrow();
    expect(() => deriveAllAddressesFromSeed(hex(MAX_SEED_BYTES))).not.toThrow();
  });

  it('does not derive one byte either side', () => {
    expect(() => deriveAllAddressesFromSeed(hex(MIN_SEED_BYTES - 1))).toThrow();
    expect(() => deriveAllAddressesFromSeed(hex(MAX_SEED_BYTES + 1))).toThrow();
  });
});

// The reason the warnings above are worded the way they are. A phrase has a
// checksum; a seed does not, and this is what that costs.
describe('why a seed needs shape checks more than a phrase does', () => {
  const addr = (h: string) => deriveAllAddressesFromSeed(h).nightExternal.bech32m.preview;

  it('one altered character silently derives a different wallet', () => {
    const a = addr(`${'0'.repeat(63)}1`);
    const b = addr(`${'0'.repeat(63)}2`);
    expect(a).not.toBe(b);
  });

  it('a truncated seed is still a valid, different wallet', () => {
    const full = hex(32);
    expect(checkHexSeed(full.slice(0, 62)).ok).toBe(true);
    expect(addr(full.slice(0, 62))).not.toBe(addr(full));
  });

  it('a phrase-derived seed is 64 bytes, and its first 32 are a different wallet', () => {
    // Why the placeholder offers 64 *or* 128 characters, and why truncating one
    // to the other is not a conversion.
    const phraseSeed = hex(64);
    expect(checkHexSeed(phraseSeed)).toMatchObject({ok: true, bytes: 64, unusualLength: false});
    expect(addr(phraseSeed)).not.toBe(addr(phraseSeed.slice(0, 64)));
  });
});
