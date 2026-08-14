/**
 * Address derivation parity test — ensures Moth derives addresses consistent
 * with the official Midnight wallet SDK from the same mnemonic. If this test
 * fails, address derivation has drifted from the expected behavior.
 *
 * Reference addresses verified on 2026-05-11.
 */

import { describe, it, expect } from 'vitest';
import { deriveAllAddressesFromSeed } from '../../../src/wallet/address.js';
import { VERIFIED_PREPROD_ADDRESS, testSeedHex } from '../../helpers/seed.js';

// Expected addresses verified against the official wallet SDK.
// There was a `nightExternalHex` entry here pinning a raw key; nothing asserted
// against it, and nothing could — `hex` is now asserted to be empty below,
// because raw role bytes were deliberately removed from WalletAddresses.
const EXPECTED = {
  preprod: {
    unshielded: VERIFIED_PREPROD_ADDRESS,
    dust: 'mn_dust_preprod1wwxhaf472uhxnltad72rmph52gdpef7a7ytq78vneqs2secjdyjzyh4t0ey',
  },
  preview: {
    unshielded: 'mn_addr_preview1qw986g7d2hx35u237672j0fr38eacad9ns6uf5ewrphmgptda6zq23wkkf',
  },
  mainnet: {
    unshielded: 'mn_addr1qw986g7d2hx35u237672j0fr38eacad9ns6uf5ewrphmgptda6zq3yy5xr',
  },
};

describe('Address Derivation Parity', () => {
  let addresses: ReturnType<typeof deriveAllAddressesFromSeed>;

  it('should derive addresses from the test mnemonic', async () => {
    addresses = deriveAllAddressesFromSeed(await testSeedHex());
  });

  it('should not expose raw private keys in hex field', () => {
    // SECURITY: hex field must be empty — raw key material was removed (CWE-200)
    expect(addresses.nightExternal.hex).toBe('');
    expect(addresses.dust.hex).toBe('');
    expect(addresses.zswap.hex).toBe('');
  });

  it('should match expected preprod unshielded address', () => {
    expect(addresses.nightExternal.bech32m.preprod).toBe(EXPECTED.preprod.unshielded);
  });

  it('should match expected preprod dust address', () => {
    expect(addresses.dust.bech32m.preprod).toBe(EXPECTED.preprod.dust);
  });

  it('should match expected preview unshielded address', () => {
    expect(addresses.nightExternal.bech32m.preview).toBe(EXPECTED.preview.unshielded);
  });

  it('should match expected mainnet unshielded address', () => {
    expect(addresses.nightExternal.bech32m.mainnet).toBe(EXPECTED.mainnet.unshielded);
  });

  it('should produce different addresses for different networks from same key', () => {
    const { bech32m } = addresses.nightExternal;
    expect(bech32m.mainnet).not.toBe(bech32m.preprod);
    expect(bech32m.preprod).not.toBe(bech32m.preview);
    expect(bech32m.preview).not.toBe(bech32m.devnet);
  });

  it('should produce different bech32m addresses for different roles', () => {
    expect(addresses.nightExternal.bech32m.preprod).not.toBe(addresses.nightInternal.bech32m.preprod);
    expect(addresses.nightExternal.bech32m.preprod).not.toBe(addresses.dust.bech32m.preprod);
    expect(addresses.nightExternal.bech32m.preprod).not.toBe(addresses.zswap.bech32m.preprod);
    expect(addresses.nightExternal.bech32m.preprod).not.toBe(addresses.metadata.bech32m.preprod);
  });

  it('should produce valid bech32m with mn_ prefix for all networks and roles', () => {
    for (const role of ['nightExternal', 'nightInternal', 'dust', 'zswap', 'metadata'] as const) {
      for (const network of ['mainnet', 'devnet', 'preview', 'preprod', 'qanet'] as const) {
        const addr = addresses[role].bech32m[network];
        expect(addr).toMatch(/^mn_/);
        expect(addr.length).toBeGreaterThan(20);
      }
    }
  });
});
