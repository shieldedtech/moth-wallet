/**
 * signMessage must sign with the wallet's own kind. An ECDSA wallet signing
 * with the schnorr default would hand a dApp a signature that verifies against
 * a verifying key the wallet never published — and the dApp connector returns
 * both, so the mismatch is silent until verification fails somewhere else.
 */

import {describe, expect, it, beforeAll} from 'vitest';
import {signMessage, signedMessageBytes} from '../../../src/wallet/sign-message.js';
import {initSdk} from '../../../src/sdk/index.js';
import {initLedger} from '../../../src/ledger/index.js';
import {testSeedHex} from '../../helpers/seed.js';

let seedHex: string;
let ledgerV9: Awaited<ReturnType<typeof initLedger>>;

beforeAll(async () => {
  await initSdk('v9');
  ledgerV9 = await initLedger('v9');
  seedHex = await testSeedHex();
});

describe('signMessage and signature kind', () => {
  it('defaults to schnorr', () => {
    expect(signMessage(seedHex, 'devnet', 'hi', 'text').signatureKind).toBe('schnorr');
  });

  it('signs with ECDSA when the wallet uses it', () => {
    expect(signMessage(seedHex, 'devnet', 'hi', 'text', 'ecdsa').signatureKind).toBe('ecdsa');
  });

  it('publishes a different verifying key per kind — the reason this matters', () => {
    const schnorr = signMessage(seedHex, 'devnet', 'hi', 'text', 'schnorr');
    const ecdsa = signMessage(seedHex, 'devnet', 'hi', 'text', 'ecdsa');
    expect(ecdsa.verifyingKey).not.toBe(schnorr.verifyingKey);
  });

  it('produces a signature the ledger verifies under each kind', () => {
    const payload = signedMessageBytes(new TextEncoder().encode('hi'));
    for (const kind of ['schnorr', 'ecdsa'] as const) {
      const {signature, verifyingKey} = signMessage(seedHex, 'devnet', 'hi', 'text', kind);
      expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ledgerV9 as any).verifySignature({tag: kind, value: verifyingKey}, payload, {tag: kind, value: signature}),
      ).toBe(true);
    }
  });
});
