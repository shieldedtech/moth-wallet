import {describe, expect, it} from 'vitest';
import {WalletManager} from '../../../src/wallet/manager.js';
import type {StorageAdapter} from '../../../src/types/wallet.js';

/** In-memory storage, so meta can be written directly and read back. */
function memoryStorage(): StorageAdapter & {entries: Map<string, Uint8Array>} {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    async read(key: string) {
      const value = entries.get(key);
      if (!value) throw new Error(`no such key ${key}`);
      return value;
    },
    async write(key: string, value: Uint8Array) {
      entries.set(key, value);
    },
    async exists(key: string) {
      return entries.has(key);
    },
    async delete(key: string) {
      entries.delete(key);
    },
    async list() {
      return [...entries.keys()];
    },
  } as StorageAdapter & {entries: Map<string, Uint8Array>};
}

const writeMeta = (storage: ReturnType<typeof memoryStorage>, name: string, meta: unknown) =>
  storage.write(`wallets/${name}.meta`, new TextEncoder().encode(JSON.stringify(meta)));

describe('WalletManager.birthdayOn', () => {
  // The regression this exists for. `list()` resolves a birthday against the
  // wallet's OWN meta.network, so a sync driven by --network read a height that
  // belonged to a different chain — or nothing — and the pre-seed gate never
  // opened. Every sync call site now asks per network instead.
  it('returns the birthday for the network asked about, not the wallet default', async () => {
    const storage = memoryStorage();
    const manager = new WalletManager(storage);
    await writeMeta(storage, 'w', {
      name: 'w',
      network: 'preview',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthdays: {preview: 400_000, preprod: 2_104_384},
    });

    await expect(manager.birthdayOn('w', 'preprod')).resolves.toBe(2_104_384);
    await expect(manager.birthdayOn('w', 'preview')).resolves.toBe(400_000);
  });

  it('returns undefined for a network the wallet asserts nothing about', async () => {
    const storage = memoryStorage();
    const manager = new WalletManager(storage);
    await writeMeta(storage, 'w', {
      name: 'w',
      network: 'preview',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthdays: {preview: 400_000},
    });

    // Not zero and not the other network's height: absent means "scan from
    // genesis", which is slow but never wrong.
    await expect(manager.birthdayOn('w', 'preprod')).resolves.toBeUndefined();
  });

  it('migrates the legacy single birthday, but only for its own network', async () => {
    const storage = memoryStorage();
    const manager = new WalletManager(storage);
    await writeMeta(storage, 'w', {
      name: 'w',
      network: 'preprod',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthday: 2_000_000,
    });

    await expect(manager.birthdayOn('w', 'preprod')).resolves.toBe(2_000_000);
    await expect(manager.birthdayOn('w', 'preview')).resolves.toBeUndefined();
  });

  it('returns undefined for a wallet with no meta at all', async () => {
    const manager = new WalletManager(memoryStorage());
    await expect(manager.birthdayOn('missing', 'preprod')).resolves.toBeUndefined();
  });
});
