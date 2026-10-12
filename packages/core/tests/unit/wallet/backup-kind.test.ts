// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {describe, it, expect, beforeEach} from 'vitest';
import {WalletManager} from '../../../src/wallet/manager.js';
import type {StorageAdapter} from '../../../src/storage/adapter.js';

// Reveal used to offer "recovery phrase" for every account and then answer with
// the seed for accounts that have no phrase, which read as the choice being
// ignored. The UI can only grey that option out if it knows, before asking for a
// password, which artifact the account actually has — hence backupKind.

class MemoryStorage implements StorageAdapter {
  private readonly files = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.files.get(key) ?? null;
  }
  async write(key: string, data: Uint8Array) {
    this.files.set(key, data);
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
  async exists(key: string) {
    return this.files.has(key);
  }
  /** Drop the field, standing in for an account written before it existed. */
  async stripBackupKind(name: string) {
    const key = [...this.files.keys()].find((k) => k.includes(name) && k.includes('meta'));
    if (!key) throw new Error(`no meta for ${name}`);
    const meta = JSON.parse(new TextDecoder().decode(this.files.get(key)!));
    delete meta.backupKind;
    this.files.set(key, new TextEncoder().encode(JSON.stringify(meta)));
  }
}

const PW = 'test-pass-1234';
const SEED = 'ab'.repeat(32);

describe('backupKind records which artifact an account can be restored from', () => {
  let storage: MemoryStorage;
  let manager: WalletManager;

  beforeEach(() => {
    storage = new MemoryStorage();
    manager = new WalletManager(storage);
  });

  const kindOf = async (name: string) =>
    (await manager.list()).find((w) => w.name === name)?.backupKind;

  it('is mnemonic for a generated account', async () => {
    await manager.generate('gen', PW, 'preview');
    expect(await kindOf('gen')).toBe('mnemonic');
  });

  it('is mnemonic for an account imported from a phrase', async () => {
    const {mnemonic} = await manager.generate('source', PW, 'preview');
    await manager.import('imported', mnemonic, PW, 'preview');
    expect(await kindOf('imported')).toBe('mnemonic');
  });

  it('is seed for an account imported from a hex seed', async () => {
    await manager.importFromSeed('from-seed', SEED, PW, 'preview');
    expect(await kindOf('from-seed')).toBe('seed');
  });

  it('is undefined for an account written before the field, not guessed', async () => {
    // Defaulting to 'mnemonic' would tell a seed-imported account it has a
    // phrase, which is the bug this field exists to stop. Unknown leaves the
    // option open and lets the revealed value explain itself, as before.
    await manager.importFromSeed('legacy', SEED, PW, 'preview');
    await storage.stripBackupKind('legacy');
    expect(await kindOf('legacy')).toBeUndefined();
  });

  it('is backfilled on unlock, the one moment the keystore reveals it', async () => {
    await manager.importFromSeed('legacy', SEED, PW, 'preview');
    await storage.stripBackupKind('legacy');
    expect(await kindOf('legacy')).toBeUndefined();

    await manager.unlock('legacy', PW);
    expect(await kindOf('legacy')).toBe('seed');
  });

  it('backfills a phrase account as mnemonic, not merely non-seed', async () => {
    await manager.generate('gen', PW, 'preview');
    await storage.stripBackupKind('gen');
    await manager.unlock('gen', PW);
    expect(await kindOf('gen')).toBe('mnemonic');
  });
});
