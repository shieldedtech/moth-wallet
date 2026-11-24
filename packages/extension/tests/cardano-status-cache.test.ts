import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { CardanoStatusDTO } from '../lib/messaging/protocol';
import type { CardanoContext } from '../lib/background/cardano-session';

const { handlers, offscreenCardanoStatus, offscreenCardanoRegister, requireCardano } = vi.hoisted(() => ({
  handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
  offscreenCardanoStatus: vi.fn(),
  offscreenCardanoRegister: vi.fn(),
  requireCardano: vi.fn(),
}));

vi.mock('../lib/messaging/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messaging/protocol')>()),
  onMessage: (key: string, fn: (m: unknown) => Promise<unknown>) => {
    handlers.set(key, fn);
  },
}));
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    cardanoStatus: (...a: unknown[]) => offscreenCardanoStatus(...a),
    cardanoRegister: (...a: unknown[]) => offscreenCardanoRegister(...a),
    cardanoResolveReceiver: async () => ({ dustAddressBytes: 'ownDust' }),
  },
}));
vi.mock('../lib/background/cardano-session', () => ({
  requireCardano: (...a: unknown[]) => requireCardano(...a),
}));
vi.mock('../lib/background/sync-service', () => ({
  stopSync: vi.fn(),
  clearSnapshot: vi.fn(),
  startSync: vi.fn(),
  getSnapshot: vi.fn(),
  beginOp: vi.fn(),
  endOp: vi.fn(),
  hasOpenPorts: vi.fn(() => true),
  hasWorkInFlight: vi.fn(() => false),
  broadcastSessionLocked: vi.fn(),
  getSetupTabIds: vi.fn(() => []),
  teardown: vi.fn(),
}));

import {
  cardanoStatusKey,
  clearCardanoStatusCache,
  getCachedCardanoStatus,
  invalidateCardanoStatus,
  readCardanoStatusOnce,
} from '../lib/background/cardano-status-cache';
import { lockNow, registerHandlers } from '../lib/background/handlers';

function status(over: Partial<CardanoStatusDTO> = {}): CardanoStatusDTO {
  return {
    cardanoNetwork: 'Preprod',
    address: 'addr_test1',
    rewardAddress: 'stake_test1',
    lovelace: '5000000',
    cnight: '10',
    cnightUtxos: 1,
    registered: false,
    registeredDustAddress: null,
    registeredToThisWallet: false,
    registrationUtxo: null,
    generationRate: null,
    currentCapacity: null,
    maxCapacity: null,
    generatingFrom: null,
    secondsRemaining: null,
    midnightValid: null,
    registrationCount: 0,
    legacyDustAddress: false,
    ...over,
  };
}

function context(accountId = 'derived-0'): CardanoContext {
  return {
    session: {
      walletName: 'alice',
      network: 'preprod',
      addresses: { dust: { bech32m: { preprod: 'mn_dust_preprod1x' } } },
    },
    config: { network: 'Preprod' },
    mnemonic: 'phrase',
    accountIndex: 0,
    account: { id: accountId, label: 'Account 1', kind: 'derived' },
  } as unknown as CardanoContext;
}

const KEY = cardanoStatusKey(context());

/** A read the test finishes by hand, to hold it in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  fakeBrowser.reset();
  await clearCardanoStatusCache();
});

describe('readCardanoStatusOnce', () => {
  it('shares one read between callers that overlap, and keeps its result', async () => {
    const pending = deferred<CardanoStatusDTO>();
    const read = vi.fn(() => pending.promise);

    const first = readCardanoStatusOnce(KEY, read);
    const second = readCardanoStatusOnce(KEY, read);
    pending.resolve(status({ cnight: '42' }));

    await expect(first).resolves.toMatchObject({ cnight: '42' });
    await expect(second).resolves.toMatchObject({ cnight: '42' });
    expect(read).toHaveBeenCalledOnce();
    await expect(getCachedCardanoStatus(KEY)).resolves.toMatchObject({ status: { cnight: '42' } });
  });

  it('keeps nothing from a failed read, and reads again next time', async () => {
    await expect(readCardanoStatusOnce(KEY, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    await expect(getCachedCardanoStatus(KEY)).resolves.toBeNull();

    const read = vi.fn(async () => status());
    await readCardanoStatusOnce(KEY, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not cache a read that an invalidation overtook', async () => {
    // A read from before a transaction would put the pre-transaction state back.
    const before = deferred<CardanoStatusDTO>();
    const stale = readCardanoStatusOnce(KEY, () => before.promise);
    await invalidateCardanoStatus(KEY);

    const after = vi.fn(async () => status({ registered: true }));
    await expect(readCardanoStatusOnce(KEY, after)).resolves.toMatchObject({ registered: true });
    expect(after).toHaveBeenCalledOnce();

    before.resolve(status({ registered: false }));
    await stale;
    await expect(getCachedCardanoStatus(KEY)).resolves.toMatchObject({ status: { registered: true } });
  });

  it('keeps accounts apart', async () => {
    await readCardanoStatusOnce(KEY, async () => status({ address: 'first' }));
    await expect(getCachedCardanoStatus(cardanoStatusKey(context('imported-1')))).resolves.toBeNull();
  });
});

describe('getCachedCardanoStatus', () => {
  it('restates the finality countdown for the time it is read', async () => {
    const readAt = Date.now();
    const generatingFrom = Math.floor(readAt / 1000) + 3_600;
    await readCardanoStatusOnce(KEY, async () => status({ generatingFrom, secondsRemaining: 3_600 }));

    const later = await getCachedCardanoStatus(KEY, readAt + 600_000);
    expect(later?.status.secondsRemaining).toBe(3_000);
    const afterwards = await getCachedCardanoStatus(KEY, readAt + 7_200_000);
    expect(afterwards?.status.secondsRemaining).toBe(0);
  });
});

describe('clearCardanoStatusCache', () => {
  it('removes every cached status and nothing else', async () => {
    await fakeBrowser.storage.session.set({ session: { walletName: 'alice' } });
    await readCardanoStatusOnce(KEY, async () => status());
    await readCardanoStatusOnce(cardanoStatusKey(context('imported-1')), async () => status());

    await clearCardanoStatusCache();

    expect(await fakeBrowser.storage.session.get(null)).toEqual({ session: { walletName: 'alice' } });
  });
});

describe('Cardano status handlers', () => {
  beforeEach(() => {
    handlers.clear();
    registerHandlers();
    requireCardano.mockReset().mockResolvedValue(context());
    offscreenCardanoStatus.mockReset().mockResolvedValue(status());
    offscreenCardanoRegister.mockReset().mockResolvedValue({ txHash: 'ab'.repeat(32) });
  });

  const call = (key: string, data?: unknown) => handlers.get(key)!({ data });

  it('serves the last read without reading the chain', async () => {
    await expect(call('cardanoStatusCached')).resolves.toBeNull();
    await call('cardanoStatus');
    offscreenCardanoStatus.mockClear();

    await expect(call('cardanoStatusCached')).resolves.toMatchObject({ status: { address: 'addr_test1' } });
    expect(offscreenCardanoStatus).not.toHaveBeenCalled();
  });

  it('forgets the status after a transaction, whether or not it succeeded', async () => {
    await call('cardanoStatus');
    await call('cardanoRegister', { dustAddress: 'dust' });
    await expect(call('cardanoStatusCached')).resolves.toBeNull();

    await call('cardanoStatus');
    offscreenCardanoRegister.mockRejectedValueOnce(new Error('submit timed out'));
    await expect(call('cardanoRegister', { dustAddress: 'dust' })).rejects.toThrow('submit timed out');
    await expect(call('cardanoStatusCached')).resolves.toBeNull();
  });

  it('forgets every status on lock', async () => {
    await call('cardanoStatus');
    await lockNow();
    await expect(getCachedCardanoStatus(KEY)).resolves.toBeNull();
  });
});
