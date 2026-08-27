/**
 * Key derivation is fork-invariant: v8 and v9 produce byte-identical public
 * keys from the same seed. wallet/address.ts relies on this — it derives for
 * every network in one call, spanning both ledger generations, so it takes
 * fromSeed from v8 directly rather than asking the seam for a "current" ledger
 * that would not exist.
 *
 * If a future release breaks this, addresses become ledger-specific and that
 * assumption collapses silently. Hence this test.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {initLedger, type LedgerModule} from '../../../src/ledger/index.js';

let v8: LedgerModule;
let v9: LedgerModule;

beforeAll(async () => {
  v8 = await initLedger('v8');
  v9 = await initLedger('v9');
});

/** WASM hands these back as hex strings or bigints depending on the field. */
const norm = (x: unknown): string =>
  typeof x === 'bigint' ? x.toString(16) : typeof x === 'string' ? x : Buffer.from(x as Uint8Array).toString('hex');

const seeds: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['patterned', Uint8Array.from({length: 32}, (_, i) => (i * 7 + 3) & 0xff)],
  ['all zero', new Uint8Array(32).fill(0)],
  ['descending', Uint8Array.from({length: 32}, (_, i) => (255 - i) & 0xff)],
];

describe('derivation invariance across the ledger fork', () => {
  for (const [label, seed] of seeds) {
    it(`derives identical shielded keys on both ledgers (${label} seed)`, () => {
      const a = v8.ZswapSecretKeys.fromSeed(seed);
      const b = v9.ZswapSecretKeys.fromSeed(seed);
      expect(norm(a.coinPublicKey)).toBe(norm(b.coinPublicKey));
      expect(norm(a.encryptionPublicKey)).toBe(norm(b.encryptionPublicKey));
    });

    it(`derives an identical DUST key on both ledgers (${label} seed)`, () => {
      expect(norm(v8.DustSecretKey.fromSeed(seed).publicKey)).toBe(
        norm(v9.DustSecretKey.fromSeed(seed).publicKey),
      );
    });
  }

  it('still keeps the key objects at distinct class identity', () => {
    // Invariant values, but not interchangeable objects: a v8 key must never be
    // handed to v9 transaction code.
    const seed = new Uint8Array(32).fill(1);
    expect(v8.ZswapSecretKeys.fromSeed(seed)).not.toBeInstanceOf(v9.ZswapSecretKeys);
  });
});
