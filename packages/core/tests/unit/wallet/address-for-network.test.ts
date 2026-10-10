import {describe, expect, it} from 'vitest';
import {addressForNetwork, decodeBech32mAddress} from '../../../src/wallet/address.js';

// A Midnight address is a payload plus a network HRP, and the payload is key
// material with no network of its own. `WalletMeta.address` is written once at
// create/import, so a wallet created on devnet and since used on preprod still
// reports its devnet address — and a caller that forwards it sends a
// wrong-network address wherever it goes. `moth dust status` did exactly that and
// failed against preprod's indexer (#107).
//
// These are the real addresses from that report: one wallet, two encodings.
const DEVNET = 'mn_addr_devnet18ph9d9mn7teq2qvanjgp4l9u0kqyl4vxwlnhjxc3nhj3mnmf03eskkpdrr';
const PREPROD = 'mn_addr_preprod18ph9d9mn7teq2qvanjgp4l9u0kqyl4vxwlnhjxc3nhj3mnmf03esngsypp';
const PAYLOAD = '386e569773f2f205019d9c901afcbc7d804fd58677e7791b119de51dcf697c73';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('addressForNetwork', () => {
  it('re-encodes for another network, preserving the key material exactly', () => {
    const out = addressForNetwork(DEVNET, 'preprod');
    expect(out).toBe(PREPROD);
    expect(hex(decodeBech32mAddress(out!).data)).toBe(PAYLOAD);
  });

  it('round-trips back', () => {
    expect(addressForNetwork(PREPROD, 'devnet')).toBe(DEVNET);
  });

  it('returns the input unchanged when it is already for that network', () => {
    // Not merely equal — the same string, so callers can skip work cheaply.
    expect(addressForNetwork(PREPROD, 'preprod')).toBe(PREPROD);
  });

  it('needs no keys: the payload is what carries identity', () => {
    // The whole reason this is possible without an unlock.
    expect(hex(decodeBech32mAddress(DEVNET).data)).toBe(hex(decodeBech32mAddress(PREPROD).data));
  });

  it('returns null rather than throwing on input it cannot parse', () => {
    // Callers fall back to the stored value; losing the field would be worse
    // than showing a creation-time one.
    expect(addressForNetwork('not-an-address', 'preprod')).toBeNull();
    expect(addressForNetwork('', 'preprod')).toBeNull();
    expect(addressForNetwork('(locked)', 'preprod')).toBeNull();
  });
});
