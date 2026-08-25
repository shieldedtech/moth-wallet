import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// Deleting an account must not be able to close the process doing the deleting.
//
// lockNow() starts a teardown it does not await, and teardown closes the
// offscreen document — so locking BEFORE the removal raced a shutdown of the
// very thing performing it. Interrupted, the account stayed in the config with
// its keystore already gone: the panel then shows Unlock (the "no accounts yet"
// screen needs an EMPTY list) for a keystore no passphrase can match, which with
// a single account is a wallet with no way back in.

const walletRemoveHost = vi.fn<(name: string, network: string) => Promise<void>>();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    walletRemove: (...args: unknown[]) => walletRemoveHost(...(args as [string, string])),
  },
}));

const beginOp = vi.fn();
const endOp = vi.fn();
const teardown = vi.fn(async () => {});
const clearSnapshot = vi.fn(async () => {});
vi.mock('../lib/background/sync-service', () => ({
  beginOp: () => beginOp(),
  endOp: () => endOp(),
  teardown: (...a: unknown[]) => teardown(...(a as [])),
  clearSnapshot: () => clearSnapshot(),
  stopSync: vi.fn(async () => {}),
  startSync: vi.fn(async () => {}),
  getSnapshot: vi.fn(),
  hasOpenPorts: vi.fn(() => true),
  getSetupTabIds: vi.fn(() => []),
}));

import { removeWallet } from '../lib/background/handlers';
import { getSession, saveSession, type Session } from '../lib/background/session';
import { updateSettings } from '../lib/background/settings';

const SESSION = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  address: 'mn_unshielded_devnet',
  addresses: { nightExternal: { hex: '', bech32m: { devnet: 'mn_unshielded_devnet' } } },
  shieldedCoinPublicKey: 'c0'.repeat(16),
  shieldedEncryptionPublicKey: 'e0'.repeat(16),
  network: 'devnet',
  unlockedAt: 1,
} as unknown as Session;

describe('walletRemove handler', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    walletRemoveHost.mockReset().mockResolvedValue(undefined);
    beginOp.mockReset();
    endOp.mockReset();
    teardown.mockReset().mockResolvedValue(undefined);
    clearSnapshot.mockReset().mockResolvedValue(undefined);
    await updateSettings({ network: 'devnet', customEndpoints: null });
    await saveSession(SESSION);
  });

  it('removes the account before tearing the offscreen document down', async () => {
    await removeWallet('alice');

    expect(walletRemoveHost).toHaveBeenCalledWith('alice', 'devnet');
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(walletRemoveHost.mock.invocationCallOrder[0]!).toBeLessThan(teardown.mock.invocationCallOrder[0]!);
  });

  it('holds the document open for the duration with an op guard', async () => {
    // The idle teardown timer does not care that a removal is in flight; the op
    // guard is what every other multi-second offscreen call uses to say so.
    let openWhileRemoving = false;
    walletRemoveHost.mockImplementation(async () => {
      openWhileRemoving = beginOp.mock.calls.length === 1 && endOp.mock.calls.length === 0;
    });

    await removeWallet('alice');

    expect(openWhileRemoving).toBe(true);
    expect(endOp).toHaveBeenCalledTimes(1);
  });

  it('releases the op guard and still locks when the removal throws', async () => {
    walletRemoveHost.mockRejectedValue(new Error('offscreen closed'));

    await expect(removeWallet('alice')).rejects.toThrow('offscreen closed');

    expect(endOp).toHaveBeenCalledTimes(1);
  });

  it('leaves another account\'s session alone', async () => {
    await removeWallet('bob');

    expect(walletRemoveHost).toHaveBeenCalledWith('bob', 'devnet');
    // Removing an account that is not the unlocked one must not lock the wallet.
    expect(teardown).not.toHaveBeenCalled();
    expect(await getSession()).toEqual(expect.objectContaining({ walletName: 'alice' }));
  });
});
