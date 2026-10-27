import { describe, expect, it } from 'vitest';
import { dustSpendHealthTracker } from '@shieldedtech/moth-browser';
import { WalletPortError, isWalletPortError, type WalletPort } from '@shieldedtech/capsule-core';
import { healthTracked, liveWalletPort, opTracked, type SessionWallet } from '../lib/offscreen/capsule-wallet-port';

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
    // The port names the chain's refusal; the diagnosis reads the chain's words through it.
    const refusal = new WalletPortError(
      'submission',
      new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction: Custom error: 170') }),
    );
    const rejected = healthTracked(portOver(() => Promise.reject(refusal)), context);
    const thrown = await rejected.submit({} as never).catch((error: unknown) => error);
    expect(thrown).toBe(refusal);
    expect(tracker.consecutiveRejections).toBe(1);

    const accepted = healthTracked(portOver(() => Promise.resolve('tx-1')), context);
    expect(await accepted.submit({} as never)).toBe('tx-1');
    expect(tracker.consecutiveRejections).toBe(0);
  });

  it('reports what the diagnosis throws in its place as the wallet\'s submission failure', async () => {
    // Three refusals with the wedge's signature while the chain advances: the diagnosis replaces
    // the port's error with its own verdict, which the runtime must still hear as a submission failure.
    const tracker = dustSpendHealthTracker(network.id, 'capsule-port-wedge');
    tracker.recordSuccess();
    let height = 10;
    const wedgeContext = { network, walletName: 'capsule-port-wedge', probeBlock: () => Promise.resolve({ height: height++ }) };
    const refusing = healthTracked(
      portOver(() =>
        Promise.reject(
          new WalletPortError('submission', new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction: Custom error: 170') })),
        ),
      ),
      wedgeContext,
    );
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await refusing.submit({} as never).catch((error: unknown) => error);
    }
    expect(isWalletPortError(last) && last.failure).toBe('submission');
    expect((last as Error).cause).toHaveProperty('name', 'DustLedgerWedgedError');
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

// A capsule transaction is balanced and submitted outside the host's own ops, so the port reports
// the two steps that build on the engine's state as work in flight; a read of the keys is not work.
describe('opTracked', () => {
  it('runs finalize and submit inside the host\'s tracking, and the key reads outside it', async () => {
    let depth = 0;
    const seen: number[] = [];
    const track = async <T,>(run: () => Promise<T>): Promise<T> => {
      depth += 1;
      try {
        return await run();
      } finally {
        depth -= 1;
      }
    };
    const port = opTracked(
      {
        coinPublicKey: async () => {
          seen.push(depth);
          return 'cpk';
        },
        encryptionPublicKey: async () => {
          seen.push(depth);
          return 'epk';
        },
        finalize: async () => {
          seen.push(depth);
          return 'finalized' as never;
        },
        submit: async () => {
          seen.push(depth);
          return 'tx-1';
        },
      },
      track,
    );
    expect(await port.coinPublicKey()).toBe('cpk');
    expect(await port.encryptionPublicKey()).toBe('epk');
    expect(await port.finalize({} as never, new Date(0))).toBe('finalized');
    expect(await port.submit({} as never)).toBe('tx-1');
    expect(seen).toEqual([0, 0, 1, 1]);
    expect(depth).toBe(0);
  });

  it('lets go of the tracking when the step fails, so a refused transaction holds nothing in flight', async () => {
    let depth = 0;
    const track = async <T,>(run: () => Promise<T>): Promise<T> => {
      depth += 1;
      try {
        return await run();
      } finally {
        depth -= 1;
      }
    };
    const port = opTracked(
      {
        coinPublicKey: async () => 'cpk',
        encryptionPublicKey: async () => 'epk',
        finalize: () => Promise.reject(new Error('not synced')),
        submit: () => Promise.reject(new Error('refused')),
      },
      track,
    );
    await expect(port.finalize({} as never, new Date(0))).rejects.toThrow('not synced');
    await expect(port.submit({} as never)).rejects.toThrow('refused');
    expect(depth).toBe(0);
  });
});
