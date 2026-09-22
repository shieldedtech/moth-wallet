import { describe, it, expect } from 'vitest';
import { DustAddress } from '@midnightntwrk/wallet-sdk/address-format';
import * as ledger from '@midnight-ntwrk/ledger-v8';

// A DUST address is a payload plus a network HRP. Registration passes one to the
// node, and the node refuses an address encoded for a different network -- as a
// bare "Transaction submission error", with the reason nowhere in the output.
//
// designateForDust used to leave the receiver undefined and let the SDK derive
// it, which produced the address for whichever network the wallet was created
// against rather than the one being registered on. Confirmed against preview:
// six identical failures with the derived default, immediate success once the
// preview-encoded receiver was passed explicitly.
describe('DUST receiver encoding is per network', () => {
  const dsk = ledger.DustSecretKey.fromSeed(new Uint8Array(32).fill(7));

  it('gives a different address per network for the same key', () => {
    const encoded = ['preview', 'devnet', 'preprod'].map(
      (n) => String(DustAddress.encodePublicKey(n, dsk.publicKey)),
    );
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it('prefixes each with that network, which is what the node checks', () => {
    for (const net of ['preview', 'devnet', 'preprod']) {
      expect(String(DustAddress.encodePublicKey(net, dsk.publicKey))).toMatch(
        new RegExp(`^mn_dust_${net}1`),
      );
    }
  });

  it('never silently reuses one network\'s encoding for another', () => {
    // The failure this guards: a devnet-encoded receiver handed to a preview
    // registration. The two must not be interchangeable at the string level.
    const devnet = String(DustAddress.encodePublicKey('devnet', dsk.publicKey));
    const preview = String(DustAddress.encodePublicKey('preview', dsk.publicKey));
    expect(devnet).not.toBe(preview);
    expect(devnet.startsWith('mn_dust_preview')).toBe(false);
  });
});
