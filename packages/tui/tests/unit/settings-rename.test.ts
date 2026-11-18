import { describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@shieldedtech/moth-wallet';
import { loadSettings, saveSettings, type TuiSettings } from '../../src/settings.js';

// No network is renamed today, so a rename is injected to keep the override
// migration pinned for the next one.
const RETIRED = 'stagenet';
const CURRENT = 'qanet';

vi.mock('@shieldedtech/moth-wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shieldedtech/moth-wallet')>();
  return { ...actual, canonicalNetworkId: (id: string) => (id === 'stagenet' ? 'qanet' : id) };
});

const encoder = new TextEncoder();

function storageWith(settings: Record<string, unknown>): StorageAdapter {
  const files = new Map<string, Uint8Array>([
    ['tui/settings.json', encoder.encode(JSON.stringify(settings))],
  ]);
  return {
    read: async (key: string) => files.get(key) ?? null,
    write: async (key: string, data: Uint8Array) => void files.set(key, data),
    delete: async (key: string) => void files.delete(key),
    list: async () => [...files.keys()],
    exists: async (key: string) => files.has(key),
  } as unknown as StorageAdapter;
}

describe('TUI settings saved on a renamed network', () => {
  const OVERRIDES = {
    nodeUrl: 'ws://localhost:19944',
    indexerUrl: 'http://localhost:18088/api/v4/graphql',
    prover: { type: 'wasm' as const },
  };

  it('resolves the remembered network', async () => {
    expect((await loadSettings(storageWith({ lastNetwork: RETIRED }))).lastNetwork).toBe(CURRENT);
  });

  it('carries endpoint overrides onto the new key', async () => {
    const settings = await loadSettings(
      storageWith({ lastNetwork: RETIRED, networkOverrides: { [RETIRED]: OVERRIDES } }),
    );

    expect(settings.networkOverrides[CURRENT]).toEqual(OVERRIDES);
    expect(settings.networkOverrides[RETIRED]).toBeUndefined();
  });

  it('keeps overrides across a save and a second launch', async () => {
    // The first launch persists `lastNetwork` under the new id; if the overrides
    // stayed under the old key, the second launch would silently drop them.
    const storage = storageWith({ lastNetwork: RETIRED, networkOverrides: { [RETIRED]: OVERRIDES } });
    await saveSettings(storage, (await loadSettings(storage)) satisfies TuiSettings);

    const second = await loadSettings(storage);

    expect(second.lastNetwork).toBe(CURRENT);
    expect(second.networkOverrides[second.lastNetwork]).toEqual(OVERRIDES);
  });

  it('keeps the entry already filed under the current name', async () => {
    const settings = await loadSettings(
      storageWith({
        lastNetwork: RETIRED,
        networkOverrides: { [RETIRED]: OVERRIDES, [CURRENT]: { nodeUrl: 'ws://localhost:29944' } },
      }),
    );

    expect(settings.networkOverrides[CURRENT]).toEqual({ nodeUrl: 'ws://localhost:29944' });
  });
});
