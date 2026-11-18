import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '@shieldedtech/moth-wallet';
import { loadSettings, saveSettings, type TuiSettings } from '../../src/settings.js';

const encoder = new TextEncoder();

/** Minimal StorageAdapter over a Map — the settings path only reads and writes
 *  one key, so there is nothing to gain from a filesystem here. */
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

// `local` (midnight-node local-env) and `undeployed` (the dev stack) are separate
// chains. `local` was once folded into `undeployed`, which moved a local-env
// profile — and its endpoint overrides — onto the wrong network.
describe('TUI settings saved on the local network', () => {
  const OVERRIDES = {
    nodeUrl: 'ws://localhost:19933',
    indexerUrl: 'http://localhost:18088/api/v4/graphql',
    prover: { type: 'wasm' as const },
  };

  it('keeps the remembered network', async () => {
    const settings = await loadSettings(storageWith({ lastNetwork: 'local' }));

    expect(settings.lastNetwork).toBe('local');
  });

  it('keeps local and undeployed overrides apart across a round trip', async () => {
    const undeployed = { nodeUrl: 'ws://localhost:29944' };
    const storage = storageWith({
      lastNetwork: 'local',
      networkOverrides: { local: OVERRIDES, undeployed },
    });
    const first = await loadSettings(storage);
    await saveSettings(storage, first satisfies TuiSettings);

    const second = await loadSettings(storage);

    expect(second.lastNetwork).toBe('local');
    expect(second.networkOverrides.local).toEqual(OVERRIDES);
    expect(second.networkOverrides.undeployed).toEqual(undeployed);
  });
});
