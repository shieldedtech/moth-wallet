import { describe, it, expect } from 'vitest';
import { isShieldedName, shieldedNameOf, hasConfusableChars } from '../lib/ui/name-resolve';

describe('isShieldedName', () => {
  it('accepts a .shielded name', () => {
    expect(isShieldedName('alice.shielded')).toBe(true);
    expect(isShieldedName('  Alice.SHIELDED  ')).toBe(true);
  });
  it('rejects a bare suffix, an address, and empty input', () => {
    expect(isShieldedName('.shielded')).toBe(false);
    expect(isShieldedName('mn_addr1qxyz')).toBe(false);
    expect(isShieldedName('alice')).toBe(false);
    expect(isShieldedName('')).toBe(false);
  });
});

describe('shieldedNameOf', () => {
  it('strips the suffix and normalizes (NFC + trim + lowercase)', () => {
    expect(shieldedNameOf('Alice.shielded')).toBe('alice');
    expect(shieldedNameOf('  SATOSHI.shielded ')).toBe('satoshi');
  });
  it('returns null for non-names', () => {
    expect(shieldedNameOf('alice')).toBeNull();
    expect(shieldedNameOf('mn_addr1qxyz')).toBeNull();
  });
});

describe('hasConfusableChars', () => {
  it('does not warn on pure-ASCII names', () => {
    expect(hasConfusableChars('alice')).toBe(false);
    expect(hasConfusableChars('bob-1')).toBe(false);
  });
  it('warns on non-ASCII (homograph) characters', () => {
    // Cyrillic 'а' (U+0430) mimicking Latin 'a'
    expect(hasConfusableChars('аlice')).toBe(true);
    expect(hasConfusableChars('café')).toBe(true);
  });
});
