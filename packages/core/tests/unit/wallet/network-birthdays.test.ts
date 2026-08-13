import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../../src/storage/adapter.js';
import { WalletManager } from '../../../src/wallet/manager.js';

class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.values.get(key) ?? null;
  }
  async write(key: string, data: Uint8Array) {
    this.values.set(key, data);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list(prefix: string) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async exists(key: string) {
    return this.values.has(key);
  }
}

const PASS = 'test-passphrase';
const decoder = new TextDecoder();

async function readMeta(storage: MemoryStorage, name: string) {
  const raw = await storage.read(`wallets/${name}.meta`);
  return JSON.parse(decoder.decode(raw!)) as {
    network: string;
    birthday?: number;
    birthdays?: Record<string, number>;
    createdHere?: boolean;
  };
}

/** Write a meta document by hand, to stand in for wallets stored before
 *  `birthdays` and `createdHere` existed. */
async function seedLegacyMeta(storage: MemoryStorage, meta: Record<string, unknown>) {
  await storage.write(
    `wallets/${meta.name}.meta`,
    new TextEncoder().encode(JSON.stringify(meta)),
  );
  await storage.write(
    'config.json',
    new TextEncoder().encode(
      JSON.stringify({ activeWallet: meta.name, wallets: [meta.name], defaultNetwork: 'preprod', configVersion: 1 }),
    ),
  );
}

describe('per-network birthdays', () => {
  it('records a created wallet’s birthday under the network it was created on', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);
    await manager.generate('w', PASS, 'preprod', 1985914);

    const meta = await readMeta(storage, 'w');
    expect(meta.birthdays).toEqual({ preprod: 1985914 });
    expect(meta.createdHere).toBe(true);
    // The legacy single field is no longer written for new wallets.
    expect(meta.birthday).toBeUndefined();
  });

  it('keeps the old network’s birthday when switching, so a return trip can still pre-seed', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);
    await manager.generate('w', PASS, 'preprod', 1985914);

    await manager.setNetwork('w', 'preview', undefined, 360663);

    const meta = await readMeta(storage, 'w');
    expect(meta.network).toBe('preview');
    // Both survive. Losing preprod's was the defect: without a birthday the
    // pre-seed guard can never pass, so every sync after a switch walked from
    // genesis.
    expect(meta.birthdays).toEqual({ preprod: 1985914, preview: 360663 });
  });

  it('reports the birthday for the network the wallet is currently on', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);
    await manager.generate('w', PASS, 'preprod', 1985914);
    await manager.setNetwork('w', 'preview', undefined, 360663);

    expect((await manager.list()).find((w) => w.name === 'w')?.birthday).toBe(360663);
  });

  it('does NOT overwrite a birthday when returning to a network', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);
    await manager.generate('w', PASS, 'preprod', 1985914);
    await manager.setNetwork('w', 'preview', undefined, 360663);

    // Back to preprod, much later. The wallet may have transacted there before
    // leaving, so the ORIGINAL height stands — a later tip would skip that
    // history and drop funds from view.
    await manager.setNetwork('w', 'preprod', undefined, 2_045_150);

    expect((await readMeta(storage, 'w')).birthdays).toEqual({ preprod: 1985914, preview: 360663 });
  });

  it('never records a birthday for an imported wallet, on any network', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);
    const phrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon abandon abandon abandon art';
    await manager.import('w', phrase, PASS, 'preprod');

    await manager.setNetwork('w', 'preview', undefined, 360663);

    const meta = await readMeta(storage, 'w');
    expect(meta.createdHere).toBe(false);
    // An imported wallet may hold funds on any chain at any height, so it must
    // scan from genesis rather than be told where its history starts.
    expect(meta.birthdays).toBeUndefined();
    expect((await manager.list()).find((w) => w.name === 'w')?.birthday).toBeUndefined();
  });
});

describe('migration from the legacy single birthday', () => {
  it('reads a pre-existing birthday for the network it belonged to', async () => {
    const storage = new MemoryStorage();
    await seedLegacyMeta(storage, {
      name: 'old',
      network: 'preprod',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthday: 1985914,
    });

    expect((await new WalletManager(storage).list()).find((w) => w.name === 'old')?.birthday).toBe(1985914);
  });

  it('folds it into the map on the first switch instead of discarding it', async () => {
    const storage = new MemoryStorage();
    await seedLegacyMeta(storage, {
      name: 'old',
      network: 'preprod',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthday: 1985914,
    });

    await new WalletManager(storage).setNetwork('old', 'preview', undefined, 360663);

    const meta = await readMeta(storage, 'old');
    expect(meta.birthdays?.preprod).toBe(1985914);
  });

  it('treats a legacy wallet as imported, so it gains no NEW birthday', async () => {
    const storage = new MemoryStorage();
    await seedLegacyMeta(storage, {
      name: 'old',
      network: 'preprod',
      createdAt: '2026-08-01T00:00:00.000Z',
      birthday: 1985914,
    });

    await new WalletManager(storage).setNetwork('old', 'preview', undefined, 360663);

    // createdHere is absent on pre-existing wallets, and the conservative
    // reading is "imported": a slow sync costs time, whereas wrongly assuming
    // "created" would let a restored wallet skip its own history.
    expect((await readMeta(storage, 'old')).birthdays?.preview).toBeUndefined();
  });
});
