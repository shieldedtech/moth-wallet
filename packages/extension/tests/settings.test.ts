import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_NETWORKS, serverProver } from '@shieldedtech/moth-wallet/types/network';
import { DEFAULT_SETTINGS, getNetworkConfig, getSettings, updateSettings } from '../lib/background/settings';

describe('extension settings', () => {
  beforeEach(() => fakeBrowser.reset());

  it('restores saved endpoint overrides for the selected named network', async () => {
    const customEndpoints = {
      nodeUrl: 'https://legacy-node.example',
      indexerUrl: 'https://legacy-indexer.example',
      proofServerUrl: 'https://legacy-proof.example',
    };
    await fakeBrowser.storage.local.set({
      settings: {
        network: 'preview',
        customEndpoints,
      },
    });

    const migratedEndpoints = {
      nodeUrl: customEndpoints.nodeUrl,
      indexerUrl: customEndpoints.indexerUrl,
      prover: serverProver(customEndpoints.proofServerUrl),
    };
    expect(await getSettings()).toEqual({ network: 'preview', customEndpoints: migratedEndpoints, autoLockMinutes: 60, nameResolverUrl: null, preseedWarming: false, developerMode: false, blockfrostProjectId: null, blockfrostProjectIds: {}, blockfrostUrl: null, cnightPolicyId: null, cnightAssetName: null });
    expect(await getNetworkConfig()).toEqual({ id: 'preview', ...migratedEndpoints });
  });

  // `local` (midnight-node local-env) is its own chain, not an alias for
  // `undeployed`: folding it in put local-env wallets on the wrong address prefix.
  it('keeps a selection saved on local', async () => {
    await fakeBrowser.storage.local.set({ settings: { network: 'local' } });

    expect((await getSettings()).network).toBe('local');
    expect(await getNetworkConfig()).toEqual(DEFAULT_NETWORKS.local);
  });

  it('keeps endpoint overrides saved on local', async () => {
    // Overrides belong to the selected network, and `getNetworkConfig` only
    // applies them when the requested network IS the selected one.
    const customEndpoints = {
      nodeUrl: 'ws://localhost:19944',
      indexerUrl: 'http://localhost:18088/api/v4/graphql',
      prover: { type: 'wasm' as const },
    };
    await fakeBrowser.storage.local.set({ settings: { network: 'local', customEndpoints } });

    expect(await getNetworkConfig()).toEqual({ id: 'local', ...customEndpoints });
  });

  // A write used to persist the whole resolved object, so the first one — every
  // unlock saves the account's network — froze the then-current defaults, and a
  // default could never reach an install that had been unlocked once.
  it('persists only the keys a caller set, leaving untouched defaults live', async () => {
    await updateSettings({ developerMode: true });

    const stored = (await fakeBrowser.storage.local.get('settings')).settings as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['developerMode']);
    expect((await getSettings()).autoLockMinutes).toBe(DEFAULT_SETTINGS.autoLockMinutes);
  });

  it('keeps an explicit auto-lock choice, demo mode included, across later writes', async () => {
    await updateSettings({ autoLockMinutes: null });
    await updateSettings({ developerMode: true });

    expect((await getSettings()).autoLockMinutes).toBeNull();
  });

  it('restores WASM proving as part of a network override', async () => {
    const customEndpoints = {
      nodeUrl: DEFAULT_NETWORKS.devnet!.nodeUrl,
      indexerUrl: DEFAULT_NETWORKS.devnet!.indexerUrl,
      prover: { type: 'wasm' as const },
    };
    await fakeBrowser.storage.local.set({settings: {network: 'devnet', customEndpoints}});

    expect(await getNetworkConfig()).toEqual({id: 'devnet', ...customEndpoints});
  });
});
