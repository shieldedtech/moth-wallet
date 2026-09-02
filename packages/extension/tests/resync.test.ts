import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

const syncCacheReset = vi.fn<() => Promise<void>>();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    syncCacheReset: (...args: unknown[]) => syncCacheReset(...(args as [])),
  },
}));

const stopSync = vi.fn<() => Promise<void>>();
const clearSnapshot = vi.fn<() => Promise<void>>();
const startSync = vi.fn<() => Promise<void>>();
const beginOp = vi.fn();
const endOp = vi.fn();
vi.mock('../lib/background/sync-service', () => ({
  stopSync: () => stopSync(),
  clearSnapshot: () => clearSnapshot(),
  startSync: (...args: unknown[]) => startSync(...(args as [])),
  getSnapshot: vi.fn(),
  beginOp: () => beginOp(),
  endOp: () => endOp(),
  hasOpenPorts: vi.fn(() => true),
  hasWorkInFlight: vi.fn(() => false),
  broadcastSessionLocked: vi.fn(),
  getSetupTabIds: vi.fn(() => []),
  teardown: vi.fn(),
}));

import { resyncFromScratch } from '../lib/background/handlers';
import { saveSession, type Session } from '../lib/background/session';
import { updateSettings } from '../lib/background/settings';

const SESSION: Session = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  address: 'mn_unshielded_undeployed',
  addresses: {
    nightExternal: { hex: '', bech32m: { undeployed: 'mn_unshielded_undeployed' } },
  } as unknown as Session['addresses'],
  shieldedCoinPublicKey: 'c0'.repeat(16),
  shieldedEncryptionPublicKey: 'e0'.repeat(16),
  network: 'undeployed',
  unlockedAt: 1,
};

describe('resyncFromScratch', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    syncCacheReset.mockReset().mockResolvedValue(undefined);
    stopSync.mockReset().mockResolvedValue(undefined);
    clearSnapshot.mockReset().mockResolvedValue(undefined);
    startSync.mockReset().mockResolvedValue(undefined);
    beginOp.mockReset();
    endOp.mockReset();
    await updateSettings({ network: 'undeployed', customEndpoints: null });
    await saveSession(SESSION);
  });

  it('stops, clears the account and network caches, drops the snapshot, then restarts sync', async () => {
    await resyncFromScratch();

    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(syncCacheReset).toHaveBeenCalledWith({
      walletName: 'alice',
      network: expect.objectContaining({ id: 'undeployed' }),
    });
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(startSync).toHaveBeenCalledWith(
      expect.objectContaining({ walletName: 'alice', network: 'undeployed' }),
      expect.objectContaining({ id: 'undeployed' }),
    );

    // Order matters: the engine writes its final state on stop, so a clear that
    // ran first would be undone; and the panel must see the reset before the
    // new sync's first balances arrive.
    const order = [stopSync, syncCacheReset, clearSnapshot, startSync].map((fn) => fn.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('brackets the whole reset as one in-flight op so idle teardown cannot interrupt it', async () => {
    await resyncFromScratch();
    expect(beginOp).toHaveBeenCalledTimes(1);
    expect(endOp).toHaveBeenCalledTimes(1);
    expect(beginOp.mock.invocationCallOrder[0]!).toBeLessThan(stopSync.mock.invocationCallOrder[0]!);
    expect(endOp.mock.invocationCallOrder[0]!).toBeGreaterThan(startSync.mock.invocationCallOrder[0]!);
  });

  it('restarts sync even when the clear fails, and still surfaces the failure', async () => {
    syncCacheReset.mockRejectedValue(new Error('IndexedDB unavailable'));

    await expect(resyncFromScratch()).rejects.toThrow('IndexedDB unavailable');
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(clearSnapshot).not.toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledTimes(1);
  });

  it('refuses when the wallet is locked, touching nothing', async () => {
    fakeBrowser.reset();
    await updateSettings({ network: 'undeployed', customEndpoints: null });

    await expect(resyncFromScratch()).rejects.toThrow('Wallet is locked');
    expect(stopSync).not.toHaveBeenCalled();
    expect(syncCacheReset).not.toHaveBeenCalled();
  });
});
