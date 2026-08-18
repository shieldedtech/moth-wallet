/**
 * The wallet-SDK seam. wallet-sdk@1.2.0 binds to ledger-v8; the v9 line is
 * installed under an npm alias. Both must load in one process, and each must
 * pair with its own ledger — mixing them is what produced "expected instance of
 * DustParameters" when a stagenet preseed was attempted. See ADR-0006 and
 * docs/plans/ledger-v9-sdk-seam.md.
 */

import {describe, expect, it, beforeEach} from 'vitest';
import {
  initSdk,
  sdk,
  sdkFor,
  activeSdkVersion,
  resetSdkRegistry,
  createKeystoreFor,
} from '../../../src/sdk/index.js';
import {initLedger} from '../../../src/ledger/index.js';

const SEED = new Uint8Array(32).fill(7);

describe('sdk seam', () => {
  beforeEach(() => resetSdkRegistry());

  it('refuses sync access before anything is loaded', () => {
    expect(() => sdk()).toThrow(/initSdk/);
  });

  it('loads the v8 line', async () => {
    await initSdk('v8');
    expect(activeSdkVersion()).toBe('v8');
    expect(typeof sdk().unshielded.createKeystore).toBe('function');
  });

  it('loads the v9 line', async () => {
    await initSdk('v9');
    expect(activeSdkVersion()).toBe('v9');
    expect(typeof sdk().unshielded.createKeystore).toBe('function');
  });

  it('holds both generations at once, as distinct modules', async () => {
    const v8 = await initSdk('v8');
    const v9 = await initSdk('v9');
    expect(v8).not.toBe(v9);
    expect(sdkFor('v8')).toBe(v8);
    expect(sdkFor('v9')).toBe(v9);
  });

  it('refuses a generation that was never loaded', async () => {
    await initSdk('v8');
    expect(() => sdkFor('v9')).toThrow(/not loaded/i);
  });
});

describe('createKeystoreFor', () => {
  beforeEach(() => resetSdkRegistry());

  it('uses the raw-secret shape on v8', async () => {
    await initSdk('v8');
    expect(String(createKeystoreFor(SEED, 'devnet').getBech32Address())).toMatch(/^mn_addr/);
  });

  it('uses the {kind, secret} shape on v9, which a v8-shaped call would reject', async () => {
    await initSdk('v9');
    expect(String(createKeystoreFor(SEED, 'devnet').getBech32Address())).toMatch(/^mn_addr/);
  });

  it('derives the same schnorr address from both generations', async () => {
    await initSdk('v8');
    const a = String(createKeystoreFor(SEED, 'devnet').getBech32Address());
    await initSdk('v9');
    const b = String(createKeystoreFor(SEED, 'devnet', 'schnorr').getBech32Address());
    expect(a).toBe(b);
  });

  it('gives ECDSA a different unshielded address — kind selects an identity', async () => {
    await initSdk('v9');
    const schnorr = String(createKeystoreFor(SEED, 'devnet', 'schnorr').getBech32Address());
    const ecdsa = String(createKeystoreFor(SEED, 'devnet', 'ecdsa').getBech32Address());
    expect(ecdsa).not.toBe(schnorr);
  });
});

describe('ledger/SDK pairing (the DustParameters regression)', () => {
  beforeEach(() => resetSdkRegistry());

  it('accepts a v9 ledger DustParameters through the v9 SDK', async () => {
    const sdkV9 = await initSdk('v9');
    const ledgerV9 = await initLedger('v9');
    const builder = new sdkV9.dustV1.V1Builder().withDefaults();
    const cfg = {
      networkId: 'devnet',
      costParameters: {nightDustRatio: 1n, generationDecayRate: 1n, dustGracePeriodSeconds: 1n},
      indexerClientConnection: {indexerHttpUrl: 'http://localhost/graphql', indexerWsUrl: 'ws://localhost/graphql'},
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdkV9.dust.CustomDustWallet as any)(cfg, builder).startWithSecretKey(
        ledgerV9.DustSecretKey.fromSeed(SEED),
        ledgerV9.LedgerParameters.initialParameters().dust,
      ),
    ).not.toThrow();
  });

  it('a v8 SDK rejects v9 DustParameters — the mismatch this seam exists to prevent', async () => {
    const sdkV8 = await initSdk('v8');
    const ledgerV9 = await initLedger('v9');
    const builder = new sdkV8.dustV1.V1Builder().withDefaults();
    const cfg = {
      networkId: 'devnet',
      costParameters: {nightDustRatio: 1n, generationDecayRate: 1n, dustGracePeriodSeconds: 1n},
      indexerClientConnection: {indexerHttpUrl: 'http://localhost/graphql', indexerWsUrl: 'ws://localhost/graphql'},
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdkV8.dust.CustomDustWallet as any)(cfg, builder).startWithSecretKey(
        ledgerV9.DustSecretKey.fromSeed(SEED),
        ledgerV9.LedgerParameters.initialParameters().dust,
      ),
    ).toThrow(/DustParameters/);
  });
});
