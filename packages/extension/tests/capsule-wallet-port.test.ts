import { describe, expect, it } from 'vitest';
import { dustSpendHealthTracker } from '@shieldedtech/moth-browser';
import type { WalletPort } from '@shieldedtech/capsule-core';
import { healthTracked, liveWalletPort, type SessionWallet } from '../lib/offscreen/capsule-wallet-port';

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

// moth stops and restarts its sync engine under the capsule host — a resync, a network edit, the
// idle teardown — so the port asks the host for the live session at every use: a wallet built over
// a facade the host has since stopped is never used again, and a transaction is balanced only once
// the session it goes through is synced.
describe('the port over the host\'s live session', () => {
  type Facade = { readonly name: string };
  /** A session wallet that records what was asked of it, in order. */
  const walletOver = (facade: Facade, log: string[]): SessionWallet => ({
    coinPublicKey: async () => {
      log.push(`${facade.name}:coinPublicKey`);
      return `cpk-${facade.name}`;
    },
    encryptionPublicKey: async () => {
      log.push(`${facade.name}:encryptionPublicKey`);
      return `epk-${facade.name}`;
    },
    waitUntilSettled: async (timeoutMs) => {
      log.push(`${facade.name}:waitUntilSettled(${timeoutMs})`);
    },
    finalize: async (tx) => {
      log.push(`${facade.name}:finalize`);
      return tx as never;
    },
    submit: async () => {
      log.push(`${facade.name}:submit`);
      return `tx-${facade.name}`;
    },
  });

  it('builds one wallet per facade and waits for the session before balancing', async () => {
    const log: string[] = [];
    const built: string[] = [];
    const facade: Facade = { name: 'a' };
    const port = liveWalletPort<Facade>({
      session: async () => ({ facade }),
      over: (f) => {
        built.push(f.name);
        return walletOver(f, log);
      },
      syncWaitMs: 1234,
    });
    expect(await port.coinPublicKey()).toBe('cpk-a');
    expect(await port.finalize({} as never, new Date())).toEqual({});
    expect(await port.submit({} as never)).toBe('tx-a');
    expect(built).toEqual(['a']);
    expect(log).toEqual(['a:coinPublicKey', 'a:waitUntilSettled(1234)', 'a:finalize', 'a:submit']);
  });

  it('moves to the session the host runs now once the facade has changed', async () => {
    const log: string[] = [];
    let facade: Facade = { name: 'a' };
    const port = liveWalletPort<Facade>({
      session: async () => ({ facade }),
      over: (f) => walletOver(f, log),
      syncWaitMs: 1,
    });
    await port.finalize({} as never, new Date());
    // The host stopped its engine and started another: the next use goes through the new one.
    facade = { name: 'b' };
    expect(await port.encryptionPublicKey()).toBe('epk-b');
    await port.finalize({} as never, new Date());
    expect(await port.submit({} as never)).toBe('tx-b');
    expect(log).toEqual([
      'a:waitUntilSettled(1)',
      'a:finalize',
      'b:encryptionPublicKey',
      'b:waitUntilSettled(1)',
      'b:finalize',
      'b:submit',
    ]);
  });

  it('tells a session that cannot be reached or synced from the transaction itself', async () => {
    const port = liveWalletPort<Facade>({
      session: () => Promise.reject(new Error('No unlocked wallet is currently synced')),
      over: (f) => walletOver(f, []),
      syncWaitMs: 1,
    });
    await expect(port.submit({} as never)).rejects.toThrow('No unlocked wallet is currently synced');

    const unsynced = liveWalletPort<Facade>({
      session: async () => ({ facade: { name: 'a' } }),
      over: (f) => ({ ...walletOver(f, []), waitUntilSettled: () => Promise.reject(new Error('the wallet did not sync within 1 ms')) }),
      syncWaitMs: 1,
    });
    await expect(unsynced.finalize({} as never, new Date())).rejects.toThrow('did not sync');
  });
});
