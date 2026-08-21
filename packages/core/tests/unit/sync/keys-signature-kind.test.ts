/**
 * The signature kind has to travel with the key bundle.
 *
 * A wallet's unshielded address depends on its kind, so a bundle derived
 * without it makes sync watch the schnorr address while the UI shows the ECDSA
 * one. Funds sent to the displayed address then never appear — the wallet is
 * watching an address it never gave out.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {deriveWalletKeys} from '../../../src/sync/operations.js';
import {initSdk, createKeystoreFor} from '../../../src/sdk/index.js';
import {testSeedHex} from '../../helpers/seed.js';

let seedHex: string;

beforeAll(async () => {
  await initSdk('v9');
  seedHex = await testSeedHex();
});

describe('deriveWalletKeys and signature kind', () => {
  it('defaults to schnorr', () => {
    expect(deriveWalletKeys(seedHex).signatureKind).toBe('schnorr');
  });

  it('carries the kind it was asked for', () => {
    expect(deriveWalletKeys(seedHex, 'ecdsa').signatureKind).toBe('ecdsa');
  });

  it('derives the same secret either way — only the encoding differs', () => {
    const schnorr = deriveWalletKeys(seedHex, 'schnorr');
    const ecdsa = deriveWalletKeys(seedHex, 'ecdsa');
    expect(Array.from(ecdsa.nightExternalKey)).toEqual(Array.from(schnorr.nightExternalKey));
  });

  it('produces a different watched address per kind, which is the whole point', () => {
    const schnorr = deriveWalletKeys(seedHex, 'schnorr');
    const ecdsa = deriveWalletKeys(seedHex, 'ecdsa');
    const addressOf = (k: typeof schnorr) =>
      String(createKeystoreFor(k.nightExternalKey, 'devnet', k.signatureKind).getBech32Address());
    expect(addressOf(ecdsa)).not.toBe(addressOf(schnorr));
  });

  it('leaves shielded and DUST keys untouched by the kind', () => {
    const schnorr = deriveWalletKeys(seedHex, 'schnorr');
    const ecdsa = deriveWalletKeys(seedHex, 'ecdsa');
    expect(String(ecdsa.shieldedSecretKeys.coinPublicKey)).toBe(String(schnorr.shieldedSecretKeys.coinPublicKey));
    expect(String(ecdsa.dustSecretKey.publicKey)).toBe(String(schnorr.dustSecretKey.publicKey));
  });
});
