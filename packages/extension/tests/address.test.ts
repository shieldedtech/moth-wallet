import { describe, expect, it } from 'vitest';
import { addressKind, isAddressOfKind } from '../lib/ui/address';

const shielded = `mn_shield-addr_preprod1${'a'.repeat(30)}`;
const unshielded = `mn_addr_preprod1${'b'.repeat(30)}`;
const dust = `mn_dust_preprod1${'c'.repeat(30)}`;

describe('addressKind', () => {
  it('classifies each address kind by its prefix', () => {
    expect(addressKind(shielded)).toBe('shielded');
    expect(addressKind(unshielded)).toBe('unshielded');
    expect(addressKind(dust)).toBe('dust');
  });

  it('does not misread a shielded address as unshielded (shared mn_ prefix)', () => {
    // "mn_shield-addr…" also begins with "mn_"; it must never be unshielded.
    expect(addressKind(shielded)).not.toBe('unshielded');
  });

  it('returns null for non-addresses and trims whitespace', () => {
    expect(addressKind('hello')).toBeNull();
    expect(addressKind('')).toBeNull();
    expect(addressKind(`  ${dust}  `)).toBe('dust');
  });
});

describe('isAddressOfKind', () => {
  it('accepts only the matching kind', () => {
    expect(isAddressOfKind('shielded', shielded)).toBe(true);
    expect(isAddressOfKind('unshielded', shielded)).toBe(false);
    expect(isAddressOfKind('dust', dust)).toBe(true);
    expect(isAddressOfKind('unshielded', unshielded)).toBe(true);
  });
});
