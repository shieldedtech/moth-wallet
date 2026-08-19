/**
 * The signer callback contract changed across the fork. v8 takes a synchronous
 * (data) => Signature; v9 takes SignSegment = (data) => Promise<Signature>,
 * made async so out-of-process signers (MPC, HSM) can be used — which is the
 * point of ECDSA support.
 *
 * Handing v9 the synchronous form gives its signing service a non-thenable and
 * surfaces as "Signer callback failed", with nothing pointing at the cause.
 */

import {describe, expect, it, beforeEach} from 'vitest';
import {initSdk, createKeystoreFor, signSegmentFor, resetSdkRegistry} from '../../../src/sdk/index.js';
import {initLedger} from '../../../src/ledger/index.js';

const SEED = new Uint8Array(32).fill(5);
const PAYLOAD = new TextEncoder().encode('midnight_signed_message:2:hi');

describe('signSegmentFor', () => {
  beforeEach(() => resetSdkRegistry());

  it('returns a synchronous signature on v8', async () => {
    await initSdk('v8');
    const out = signSegmentFor(createKeystoreFor(SEED, 'preprod'))(PAYLOAD);
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof out).toBe('string');
  });

  it('returns a promise on v9, which is what its signing service awaits', async () => {
    await initSdk('v9');
    const out = signSegmentFor(createKeystoreFor(SEED, 'devnet'))(PAYLOAD);
    expect(out).toBeInstanceOf(Promise);
    const signature = (await out) as {tag: string; value: string};
    expect(signature.tag).toBe('schnorr');
    expect(typeof signature.value).toBe('string');
  });

  it('produces a signature the ledger verifies', async () => {
    // Not compared byte-for-byte: BIP-340 Schnorr is randomised, so two
    // signings of the same payload legitimately differ. Verification is the
    // property that matters.
    const sdkV9 = await initSdk('v9');
    const ledgerV9 = await initLedger('v9');
    const ks = createKeystoreFor(SEED, 'devnet');
    const signature = await signSegmentFor(ks)(PAYLOAD);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ledgerV9 as any).verifySignature(ks.getPublicKey(), PAYLOAD, signature),
    ).toBe(true);
    expect(sdkV9.unshielded).toBeDefined();
  });

  it('produces an ECDSA-tagged signature for an ECDSA keystore', async () => {
    await initSdk('v9');
    const signature = (await signSegmentFor(createKeystoreFor(SEED, 'devnet', 'ecdsa'))(PAYLOAD)) as {tag: string};
    expect(signature.tag).toBe('ecdsa');
  });
});
