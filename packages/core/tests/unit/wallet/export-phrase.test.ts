import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../../src/storage/adapter.js';
import { WalletManager } from '../../../src/wallet/manager.js';

class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, Uint8Array>();

  async read(key: string): Promise<Uint8Array | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.values.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async exists(key: string): Promise<boolean> {
    return this.values.has(key);
  }
}

describe('WalletManager.exportPhrase', () => {
  it('returns the original mnemonic for a generated wallet', async () => {
    const manager = new WalletManager(new MemoryStorage());
    const info = await manager.generate('alice', 'hunter2 hunter2', 'devnet');

    const revealed = await manager.exportPhrase('alice', 'hunter2 hunter2');

    expect(revealed.kind).toBe('mnemonic');
    expect(revealed.value).toBe(info.mnemonic);
    expect(revealed.value.split(' ')).toHaveLength(24);
  });

  it('returns the raw hex seed for a hex-imported wallet', async () => {
    const manager = new WalletManager(new MemoryStorage());
    const seedHex = 'ab'.repeat(32);
    await manager.importFromSeed('bob', seedHex, 'hunter2 hunter2', 'devnet');

    const revealed = await manager.exportPhrase('bob', 'hunter2 hunter2');

    expect(revealed).toEqual({ kind: 'seed', value: seedHex });
  });

  it('rejects a wrong passphrase', async () => {
    const manager = new WalletManager(new MemoryStorage());
    await manager.generate('alice', 'hunter2 hunter2', 'devnet');

    await expect(manager.exportPhrase('alice', 'wrong')).rejects.toThrow(/invalid passphrase|corrupted/i);
  });

  it('throws for an unknown wallet', async () => {
    const manager = new WalletManager(new MemoryStorage());

    await expect(manager.exportPhrase('ghost', 'pw')).rejects.toThrow(/not found/);
  });
});
