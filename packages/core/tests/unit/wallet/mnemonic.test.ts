import { describe, it, expect } from 'vitest';
import {
  generateMnemonic24,
  validateMnemonic,
  mnemonicToSeed,
  hexSeedToUint8Array,
} from '../../../src/wallet/mnemonic.js';

describe('Mnemonic Utilities', () => {
  it('should generate a valid 24-word mnemonic', () => {
    const mnemonic = generateMnemonic24();
    const words = mnemonic.split(' ');
    expect(words.length).toBe(24);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('should validate a known valid mnemonic', () => {
    const valid =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
    expect(validateMnemonic(valid)).toBe(true);
  });

  it('should reject an invalid mnemonic', () => {
    expect(validateMnemonic('not a valid mnemonic phrase')).toBe(false);
    expect(validateMnemonic('')).toBe(false);
    expect(validateMnemonic('abandon')).toBe(false);
  });

  it('should convert mnemonic to seed', async () => {
    const mnemonic = generateMnemonic24();
    const seed = await mnemonicToSeed(mnemonic);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(64); // 512 bits
  });

  it('should produce deterministic seed from same mnemonic', async () => {
    const mnemonic = generateMnemonic24();
    const seed1 = await mnemonicToSeed(mnemonic);
    const seed2 = await mnemonicToSeed(mnemonic);
    expect(seed1).toEqual(seed2);
  });

  it('should convert hex seed to Uint8Array', () => {
    const hex = 'abcdef0123456789';
    const result = hexSeedToUint8Array(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(8);
    expect(result[0]).toBe(0xab);
    expect(result[1]).toBe(0xcd);
  });

  it('should reject invalid hex seed', () => {
    expect(() => hexSeedToUint8Array('not-hex')).toThrow();
    expect(() => hexSeedToUint8Array('abc')).toThrow(); // odd length
  });
});
