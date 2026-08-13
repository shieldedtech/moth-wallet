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
