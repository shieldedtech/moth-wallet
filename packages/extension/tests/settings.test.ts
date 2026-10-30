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
    expect(await getSettings()).toEqual({ network: 'preview', customEndpoints: migratedEndpoints, endpointOverrides: { preview: migratedEndpoints }, autoLockMinutes: 60, nameResolverUrl: null, preseedWarming: false, developerMode: false, blockfrostProjectId: null, blockfrostProjectIds: {}, blockfrostUrl: null, cnightPolicyId: null, cnightAssetName: null });
    expect(await getNetworkConfig()).toEqual({ id: 'preview', ...migratedEndpoints });
  });

  // `local` was a second preset for the same local devnet stack as `undeployed`,
  // pointing at a node port the stack does not listen on. Installs that selected
  // it still have it saved, and it is no longer a network the panel can offer —
  // so it has to resolve rather than fall through to a localhost guess.
  it('resolves a selection saved under the retired local id', async () => {
    await fakeBrowser.storage.local.set({ settings: { network: 'local' } });

    expect((await getSettings()).network).toBe('undeployed');
    expect(await getNetworkConfig()).toEqual(DEFAULT_NETWORKS.undeployed);
  });

  it('keeps endpoint overrides across the rename', async () => {
    // Overrides are keyed by network. If the migration moved the selection and
    // not the key the overrides are stored under, the edits would be dropped.
    const customEndpoints = {
      nodeUrl: 'ws://localhost:19944',
      indexerUrl: 'http://localhost:18088/api/v4/graphql',
      prover: { type: 'wasm' as const },
    };
    await fakeBrowser.storage.local.set({ settings: { network: 'local', customEndpoints } });

    expect(await getNetworkConfig()).toEqual({ id: 'undeployed', ...customEndpoints });
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

  it("keeps each network's overrides when another network is selected", async () => {
    const preprod = { nodeUrl: 'wss://my-node.example', indexerUrl: 'https://my-indexer.example/graphql', prover: serverProver('http://localhost:6300') };
    const preview = { ...preprod, nodeUrl: 'wss://my-preview-node.example' };

    await updateSettings({ network: 'preprod', customEndpoints: preprod });
    await updateSettings({ network: 'preview', customEndpoints: preview });
    expect(await getNetworkConfig('preprod')).toEqual({ id: 'preprod', ...preprod });

    await updateSettings({ network: 'preprod' });
    expect((await getSettings()).customEndpoints).toEqual(preprod);
    expect(await getNetworkConfig()).toEqual({ id: 'preprod', ...preprod });
    expect(await getNetworkConfig('preview')).toEqual({ id: 'preview', ...preview });
  });

  it('resets only the selected network to its preset', async () => {
    const custom = { nodeUrl: 'wss://my-node.example', indexerUrl: 'https://my-indexer.example/graphql', prover: serverProver('http://localhost:6300') };
    await updateSettings({ network: 'preview', customEndpoints: custom });
    await updateSettings({ network: 'preprod', customEndpoints: custom });

    await updateSettings({ customEndpoints: null });

    expect(await getNetworkConfig()).toEqual(DEFAULT_NETWORKS.preprod);
    expect((await getSettings()).endpointOverrides).toEqual({ preview: custom });
  });

  // Settings from before overrides were kept per network hold one override for
  // the network saved beside it. Changing the network must not hand it over.
  it('keeps a legacy override with its network when the selection changes', async () => {
    const customEndpoints = { nodeUrl: 'wss://old-node.example', indexerUrl: 'https://old-indexer.example/graphql', prover: { type: 'wasm' as const } };
    await fakeBrowser.storage.local.set({ settings: { network: 'preview', customEndpoints } });

    await updateSettings({ network: 'preprod' });

    expect(await getNetworkConfig()).toEqual(DEFAULT_NETWORKS.preprod);
    expect(await getNetworkConfig('preview')).toEqual({ id: 'preview', ...customEndpoints });
    const stored = (await fakeBrowser.storage.local.get('settings')).settings as Record<string, unknown>;
    expect(stored).not.toHaveProperty('customEndpoints');
  });

  it('re-keys overrides saved under a renamed network id', async () => {
    const customEndpoints = { nodeUrl: 'ws://localhost:19944', indexerUrl: 'http://localhost:18088/api/v4/graphql', prover: { type: 'wasm' as const } };
    await fakeBrowser.storage.local.set({ settings: { network: 'preprod', endpointOverrides: { local: customEndpoints } } });

    expect((await getSettings()).endpointOverrides).toEqual({ undeployed: customEndpoints });
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
