/**
 * Signature kind selects an unshielded identity. Shielded and DUST addresses
 * are unaffected — measured, both kinds produce the same ones — so switching
 * kind strands NIGHT at the old address and nothing else.
 *
 * ECDSA exists only on ledger v9, so an ECDSA wallet has no unshielded address
 * on a v8 network. Deriving one anyway would show an address that can never
 * receive. See ADR-0006 and docs/plans/ledger-v9-sdk-seam.md.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {deriveAllAddressesFromSeed} from '../../../src/wallet/address.js';
import {initSdk} from '../../../src/sdk/index.js';
import {testSeedHex} from '../../helpers/seed.js';

let seedHex: string;

beforeAll(async () => {
  seedHex = await testSeedHex();
  // ECDSA derivation needs the v9 generation; schnorr does not.
  await initSdk('v9');
});

describe('signature kind and addresses', () => {
  it('defaults to schnorr, preserving existing wallets', () => {
    const explicit = deriveAllAddressesFromSeed(seedHex, 'schnorr');
    const implicit = deriveAllAddressesFromSeed(seedHex);
    expect(implicit).toEqual(explicit);
  });

  it('gives ECDSA a different unshielded address on a v9 network', () => {
    const schnorr = deriveAllAddressesFromSeed(seedHex, 'schnorr');
    const ecdsa = deriveAllAddressesFromSeed(seedHex, 'ecdsa');
    expect(ecdsa.nightExternal.bech32m.stagenet).not.toBe(schnorr.nightExternal.bech32m.stagenet);
    expect(ecdsa.nightExternal.bech32m.stagenet).toMatch(/^mn_addr/);
  });

  it('leaves shielded and DUST addresses untouched by the kind', () => {
    const schnorr = deriveAllAddressesFromSeed(seedHex, 'schnorr');
    const ecdsa = deriveAllAddressesFromSeed(seedHex, 'ecdsa');
    expect(ecdsa.zswap.bech32m).toEqual(schnorr.zswap.bech32m);
    expect(ecdsa.dust.bech32m).toEqual(schnorr.dust.bech32m);
  });

  it('emits no unshielded address for ECDSA on a v8 network', () => {
    const ecdsa = deriveAllAddressesFromSeed(seedHex, 'ecdsa');
    // mainnet, preprod, preview and qanet are all protocol 1000000.
    for (const v8net of ['mainnet', 'preprod', 'preview', 'qanet']) {
      expect(ecdsa.nightExternal.bech32m[v8net]).toBe('');
    }
  });

  it('still gives schnorr a usable unshielded address on every network', () => {
    const schnorr = deriveAllAddressesFromSeed(seedHex, 'schnorr');
    for (const net of ['mainnet', 'preprod', 'preview', 'qanet', 'devnet', 'stagenet']) {
      expect(schnorr.nightExternal.bech32m[net]).toMatch(/^mn_addr/);
    }
  });
});
