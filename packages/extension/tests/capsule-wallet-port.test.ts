import { describe, expect, it } from 'vitest';
import { dustSpendHealthTracker } from '@shieldedtech/moth-browser';
import type { WalletPort } from '@shieldedtech/capsule-core';
import { healthTracked } from '../lib/offscreen/capsule-wallet-port';

// The capsule runtime submits through the same health bookkeeping as a transfer: a capsule
// transaction's InvalidDustSpendProof rejection advances the wallet's streak, and a success
// clears it — the diagnosis of a wedged dust ledger sees every fee-paying submission of the seed.
describe('the capsule runtime\'s wallet port', () => {
  const network = { id: 'undeployed', indexerUrl: 'http://localhost:8088/api/v4/graphql' };
  // The chain is probed only to tell a wedge from a stall; here it is always producing.
  const context = { network, walletName: 'capsule-port-test', probeBlock: () => Promise.resolve({ height: 7 }) };
  const portOver = (submit: () => Promise<string>): WalletPort => ({
    coinPublicKey: () => Promise.resolve('cpk'),
    encryptionPublicKey: () => Promise.resolve('epk'),
    finalize: () => Promise.reject(new Error('not in this test')),
    submit,
  });

  it('counts a rejection toward the seed\'s streak and clears it on a success', async () => {
    const tracker = dustSpendHealthTracker(network.id, 'capsule-port-test');
    tracker.recordSuccess();
    const rejected = healthTracked(
      portOver(() => Promise.reject(new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction: Custom error: 170') }))),
      context,
    );
    await expect(rejected.submit({} as never)).rejects.toThrow();
    expect(tracker.consecutiveRejections).toBe(1);

    const accepted = healthTracked(portOver(() => Promise.resolve('tx-1')), context);
    expect(await accepted.submit({} as never)).toBe('tx-1');
    expect(tracker.consecutiveRejections).toBe(0);
  });

  it('passes the keys and the finalize step through untouched', async () => {
    const port = healthTracked(portOver(() => Promise.resolve('tx')), context);
    expect(await port.coinPublicKey()).toBe('cpk');
    expect(await port.encryptionPublicKey()).toBe('epk');
    await expect(port.finalize({} as never, new Date())).rejects.toThrow('not in this test');
  });
});
