import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_NETWORKS, serverProver } from '@shieldedtech/moth-wallet/types/network';
import { getNetworkConfig, getSettings } from '../lib/background/settings';

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
    expect(await getSettings()).toEqual({ network: 'preview', customEndpoints: migratedEndpoints, autoLockMinutes: 15, nameResolverUrl: null, preseedWarming: false, developerMode: false });
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
    // Overrides belong to the selected network, and `getNetworkConfig` only
    // applies them when the requested network IS the selected one. If the
    // migration moved one side and not the other, the edits would be dropped.
    const customEndpoints = {
      nodeUrl: 'ws://localhost:19944',
      indexerUrl: 'http://localhost:18088/api/v4/graphql',
      prover: { type: 'wasm' as const },
    };
    await fakeBrowser.storage.local.set({ settings: { network: 'local', customEndpoints } });

    expect(await getNetworkConfig()).toEqual({ id: 'undeployed', ...customEndpoints });
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
