import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_NETWORKS, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';
import type { NetworkEndpoints } from '../lib/messaging/protocol';

const walletSetNetwork = vi.fn();
const syncCacheClear = vi.fn();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    walletSetNetwork: (...args: unknown[]) => walletSetNetwork(...args),
    syncCacheClear: (...args: unknown[]) => syncCacheClear(...args),
  },
}));

// Keep the suite off the network. handlers.chainTip reads the tip when moving a
// wallet to a new network; without this the test dials the real preview indexer
// and asserts against whatever height it happens to return.
const getBlock = vi.fn<() => Promise<{ height: number } | null>>();
vi.mock('@shieldedtech/moth-wallet/network/indexer-client', () => ({
  IndexerClient: class {
    getBlock() {
      return getBlock();
    }
  },
}));

const stopSync = vi.fn<() => Promise<void>>();
const clearSnapshot = vi.fn<() => Promise<void>>();
const startSync = vi.fn<() => Promise<void>>();
vi.mock('../lib/background/sync-service', () => ({
  stopSync: () => stopSync(),
  clearSnapshot: () => clearSnapshot(),
  startSync: (...args: unknown[]) => startSync(...(args as [])),
  // A failed restart is reported to the panels rather than dropped.
  broadcastSyncFailure: vi.fn(),
  getSnapshot: vi.fn(),
  beginOp: vi.fn(),
  endOp: vi.fn(),
  hasOpenPorts: vi.fn(() => true),
  getSetupTabIds: vi.fn(() => []),
  teardown: vi.fn(),
}));

import { saveNetworkConfig } from '../lib/background/handlers';
import { getSession, saveSession, type Session } from '../lib/background/session';
import { getSettings, updateSettings } from '../lib/background/settings';

const SESSION: Session = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  address: 'mn_unshielded_devnet',
  addresses: {
    nightExternal: { hex: '', bech32m: { devnet: 'mn_unshielded_devnet' } },
  } as unknown as Session['addresses'],
  shieldedCoinPublicKey: 'c0'.repeat(16),
  shieldedEncryptionPublicKey: 'e0'.repeat(16),
  network: 'devnet',
  unlockedAt: 1,
};

const PREVIEW_ADDRESSES = {
  nightExternal: { hex: '', bech32m: { preview: 'mn_unshielded_preview' } },
} as unknown as Session['addresses'];

function endpoints(network: keyof typeof DEFAULT_NETWORKS): NetworkEndpoints {
  const preset = DEFAULT_NETWORKS[network]!;
  return {
    nodeUrl: preset.nodeUrl,
    indexerUrl: preset.indexerUrl,
    prover: resolveProverConfig(preset),
  };
}

describe('saveNetworkConfig', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    walletSetNetwork.mockReset().mockResolvedValue({
      address: 'mn_unshielded_preview',
      addresses: PREVIEW_ADDRESSES,
    });
    syncCacheClear.mockReset().mockResolvedValue(undefined);
    getBlock.mockReset().mockResolvedValue({ height: 360_663 });
    stopSync.mockReset().mockResolvedValue(undefined);
    clearSnapshot.mockReset().mockResolvedValue(undefined);
    startSync.mockReset().mockResolvedValue(undefined);
    await updateSettings({ network: 'devnet', customEndpoints: null });
    await saveSession(SESSION);
  });

  it('switches the unlocked account, resets its state, and starts syncing the new network', async () => {
    const status = await saveNetworkConfig({
      network: 'preview',
      endpoints: endpoints('preview'),
      resyncApproved: true,
    });

    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(walletSetNetwork).toHaveBeenCalledWith({
      name: 'alice',
      fromNetwork: 'devnet',
      network: 'preview',
      seedHex: SESSION.seedHex,
      // Tip of the network being moved to, recorded as this wallet's
      // first-existence height there (only on first arrival, and only for
      // wallets created here — see WalletManager.setNetwork).
      birthday: 360_663,
    });
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(clearSnapshot.mock.invocationCallOrder[0]).toBeLessThan(startSync.mock.invocationCallOrder[0]!);
    expect(startSync).toHaveBeenCalledWith(
      expect.objectContaining({
        walletName: 'alice',
        network: 'preview',
        address: 'mn_unshielded_preview',
        addresses: PREVIEW_ADDRESSES,
      }),
      expect.objectContaining({ id: 'preview' }),
    );
    expect(await getSettings()).toEqual({ network: 'preview', customEndpoints: null, autoLockMinutes: 15, nameResolverUrl: null, preseedWarming: false, developerMode: false });
    expect(await getSession()).toEqual(expect.objectContaining({ network: 'preview', address: 'mn_unshielded_preview' }));
    expect(status).toEqual(expect.objectContaining({ locked: false, network: 'preview', address: 'mn_unshielded_preview' }));
  });

  it('requires confirmation before an indexer change clears state and resyncs', async () => {
    const changed = { ...endpoints('devnet'), indexerUrl: 'https://new-indexer.example/graphql' };

    await expect(
      saveNetworkConfig({ network: 'devnet', endpoints: changed, resyncApproved: false }),
    ).rejects.toThrow('Resync confirmation required');
    expect(stopSync).not.toHaveBeenCalled();

    await saveNetworkConfig({ network: 'devnet', endpoints: changed, resyncApproved: true });

    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(walletSetNetwork).not.toHaveBeenCalled();
    expect(syncCacheClear).toHaveBeenCalledWith({ walletName: 'alice', networkIds: ['devnet'] });
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(startSync).toHaveBeenCalledWith(
      expect.objectContaining({ walletName: 'alice', network: 'devnet' }),
      expect.objectContaining({ id: 'devnet', indexerUrl: changed.indexerUrl }),
    );
    expect(await getSettings()).toEqual({ network: 'devnet', customEndpoints: changed, autoLockMinutes: 15, nameResolverUrl: null, preseedWarming: false, developerMode: false });
  });

  it('restarts without clearing sync state when the prover changes', async () => {
    const changed = { ...endpoints('devnet'), prover: { type: 'wasm' } as const };

    await saveNetworkConfig({ network: 'devnet', endpoints: changed, resyncApproved: false });

    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(walletSetNetwork).not.toHaveBeenCalled();
    expect(syncCacheClear).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled();
    expect(startSync).toHaveBeenCalledWith(
      expect.objectContaining({ walletName: 'alice', network: 'devnet' }),
      expect.objectContaining({ id: 'devnet', prover: { type: 'wasm' } }),
    );
    expect(await getSettings()).toEqual({ network: 'devnet', customEndpoints: changed, autoLockMinutes: 15, nameResolverUrl: null, preseedWarming: false, developerMode: false });
  });

  it('restarts on a node edit without deleting cached sync state', async () => {
    const changed = { ...endpoints('devnet'), nodeUrl: 'https://new-node.example' };

    await saveNetworkConfig({ network: 'devnet', endpoints: changed, resyncApproved: false });

    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(syncCacheClear).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled();
    expect(startSync).toHaveBeenCalledWith(
      expect.objectContaining({ walletName: 'alice', network: 'devnet' }),
      expect.objectContaining({ id: 'devnet', nodeUrl: changed.nodeUrl }),
    );
  });

  it('does not reset or restart sync when the saved config is unchanged', async () => {
    const status = await saveNetworkConfig({
      network: 'devnet',
      endpoints: endpoints('devnet'),
      resyncApproved: false,
    });

    expect(status.network).toBe('devnet');
    expect(stopSync).not.toHaveBeenCalled();
    expect(walletSetNetwork).not.toHaveBeenCalled();
    expect(syncCacheClear).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
  });

  it('requires an unlocked wallet and a supported network', async () => {
    await expect(
      // `stagenet` has no preset and is absent from SUPPORTED_NETWORKS.
      saveNetworkConfig({ network: 'stagenet', endpoints: endpoints('preview'), resyncApproved: true }),
    ).rejects.toThrow('Unsupported network');
    await fakeBrowser.storage.session.clear();
    await expect(
      saveNetworkConfig({ network: 'preview', endpoints: endpoints('preview'), resyncApproved: true }),
    ).rejects.toThrow('Wallet is locked');
  });
});
