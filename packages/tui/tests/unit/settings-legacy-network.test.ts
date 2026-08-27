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

// A TUI profile written while the local devnet stack was called `local`. The
// failure this guards against showed up on the SECOND launch: the first one
// found the overrides under the old key and persisted `lastNetwork` as the new
// one, so the next lookup missed and the session silently reverted to preset
// endpoints — a custom node, indexer and prover choice gone with no message.
describe('TUI settings saved on the retired local network', () => {
  const OVERRIDES = {
    nodeUrl: 'ws://localhost:19944',
    indexerUrl: 'http://localhost:18088/api/v4/graphql',
    prover: { type: 'wasm' as const },
  };

  it('resolves the remembered network', async () => {
    const settings = await loadSettings(storageWith({ lastNetwork: 'local' }));

    expect(settings.lastNetwork).toBe('undeployed');
  });

  it('carries endpoint overrides onto the new key', async () => {
    const settings = await loadSettings(
      storageWith({ lastNetwork: 'local', networkOverrides: { local: OVERRIDES } }),
    );

    expect(settings.networkOverrides.undeployed).toEqual(OVERRIDES);
    expect(settings.networkOverrides.local).toBeUndefined();
  });

  it('survives the round trip that used to lose them', async () => {
    // Launch one: read the legacy profile, then persist it the way app.tsx does
    // — `lastNetwork` from the live session, `networkOverrides` carried through.
    const storage = storageWith({ lastNetwork: 'local', networkOverrides: { local: OVERRIDES } });
    const first = await loadSettings(storage);
    await saveSettings(storage, { ...first, lastNetwork: 'undeployed' } satisfies TuiSettings);

    // Launch two: the lookup that used to come back empty.
    const second = await loadSettings(storage);

    expect(second.lastNetwork).toBe('undeployed');
    expect(second.networkOverrides[second.lastNetwork]).toEqual(OVERRIDES);
  });

  it('keeps the entry already filed under the current name', async () => {
    // Both names were selectable at once, so a profile can hold an entry under
    // each. The one saved against the name in use is the more deliberate.
    const settings = await loadSettings(
      storageWith({
        lastNetwork: 'local',
        networkOverrides: { local: OVERRIDES, undeployed: { nodeUrl: 'ws://localhost:29944' } },
      }),
    );

    expect(settings.networkOverrides.undeployed).toEqual({ nodeUrl: 'ws://localhost:29944' });
  });
});
