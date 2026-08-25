import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageAdapter } from '../../../src/storage/adapter.js';
import { WalletManager } from '../../../src/wallet/manager.js';
import {
  InMemorySyncStateStore,
  emptyRefHeightKey,
  emptyRefStateKey,
  syncStateKey,
} from '../../../src/sync/sync-store.js';
import { shouldAttemptPreSeed } from '../../../src/sync/preseed-parts.js';

// Removing an account must leave nothing of it behind, because re-adding the
// same seed is the one recovery a user reaches for when a sync is stuck. State
// that survives makes the re-added account resume the removed one's sync
// instead of starting fresh — silently, since the only visible difference is a
// "Restoring … from cache" line where a "Pre-seeding" one belongs (#90).
//
// The manager is given the store its surface actually uses. That argument is
// the whole fix on the extension side: with none, core resolves the fs-backed
// store on node (right for the CLI/TUI/daemon) but a volatile in-memory one in
// the browser, so removal there cleaned nothing durable at all.

class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, Uint8Array>();
  /** Every mutating call, in order — for asserting what happens before what. */
  readonly ops: string[] = [];

  async read(key: string): Promise<Uint8Array | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.ops.push(`write ${key}`);
    this.values.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.ops.push(`delete ${key}`);
    this.values.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async exists(key: string): Promise<boolean> {
    return this.values.has(key);
  }
}

const encoder = new TextEncoder();

const PARTS = ['shielded', 'unshielded', 'dust', 'history'] as const;

async function cachedParts(store: InMemorySyncStateStore, network: string, wallet: string) {
  return {
    shielded: await store.get(syncStateKey(network, wallet, 'shielded')),
    unshielded: await store.get(syncStateKey(network, wallet, 'unshielded')),
    dust: await store.get(syncStateKey(network, wallet, 'dust')),
    history: await store.get(syncStateKey(network, wallet, 'history')),
  };
}

describe('WalletManager.remove clears sync state', () => {
  let storage: MemoryStorage;
  let store: InMemorySyncStateStore;
  let home: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    // remove() also does the node-only half of the cleanup — rm -rf on
    // ~/.moth/sync/<network>/<wallet> and its .sock — regardless of the store
    // it was handed. Under vitest that is the DEVELOPER's ~/.moth, so point HOME
    // at a temp dir for the duration: a wallet name here colliding with a real
    // one would otherwise delete real sync state.
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'moth-remove-test-'));
    process.env.HOME = home;

    storage = new MemoryStorage();
    store = new InMemorySyncStateStore();

    await storage.write(
      'config.json',
      encoder.encode(
        JSON.stringify({
          activeWallet: 'alice',
          wallets: ['alice', 'bob'],
          defaultNetwork: 'devnet',
          configVersion: 1,
        }),
      ),
    );
    // alice was created on devnet and has since been moved to preview, so she
    // has a cache on both — setNetwork deliberately keeps the old one for a
    // cheap return trip.
    await storage.write(
      'wallets/alice.meta',
      encoder.encode(
        JSON.stringify({
          name: 'alice',
          network: 'preview',
          createdAt: '2026-01-01T00:00:00.000Z',
          createdHere: true,
          birthdays: { devnet: 1_985_914, preview: 2_087_202 },
        }),
      ),
    );
    await storage.write('wallets/alice.keystore', encoder.encode('{"ciphertext":"…"}'));
    await storage.write(
      'wallets/bob.meta',
      encoder.encode(JSON.stringify({ name: 'bob', network: 'preview', createdAt: '2026-01-01T00:00:00.000Z' })),
    );
    // A real second account, keystore included — list() skips entries without
    // one, so a keystore-less fixture would not be an account at all.
    await storage.write('wallets/bob.keystore', encoder.encode('{"ciphertext":"…"}'));

    for (const part of PARTS) {
      await store.put(syncStateKey('preview', 'alice', part), `alice-preview-${part}`);
      await store.put(syncStateKey('devnet', 'alice', part), `alice-devnet-${part}`);
      await store.put(syncStateKey('preview', 'bob', part), `bob-preview-${part}`);
      await store.put(emptyRefStateKey('preview', part), `ref-preview-${part}`);
    }
    await store.put(emptyRefHeightKey('preview'), '2203416');
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('deletes the removed account state from the store it was given', async () => {
    await new WalletManager(storage, store).remove('alice');

    expect(await cachedParts(store, 'preview', 'alice')).toEqual({
      shielded: null,
      unshielded: null,
      dust: null,
      history: null,
    });
  });

  it('leaves a re-added account with nothing to restore, so it pre-seeds', async () => {
    const manager = new WalletManager(storage, store);
    await manager.remove('alice');

    // The production predicate startWalletSync branches on: every seedable part
    // absent means the re-added account takes the pre-seed path. Before the fix
    // all three were still cached in the browser and it restored instead.
    expect(shouldAttemptPreSeed(await cachedParts(store, 'preview', 'alice'))).toBe(true);
  });

  it('clears every network the account has been on, not just the current one', async () => {
    await new WalletManager(storage, store).remove('alice');

    // A cache left on a network the account was moved away from is the worse
    // half of this bug: re-adding the name with a DIFFERENT seed and switching
    // back would apply one seed's cached state while holding another's keys.
    expect(await cachedParts(store, 'devnet', 'alice')).toEqual({
      shielded: null,
      unshielded: null,
      dust: null,
      history: null,
    });
  });

  it('touches neither another account nor the shared pre-seed reference', async () => {
    await new WalletManager(storage, store).remove('alice');

    expect(await cachedParts(store, 'preview', 'bob')).toEqual({
      shielded: 'bob-preview-shielded',
      unshielded: 'bob-preview-unshielded',
      dust: 'bob-preview-dust',
      history: 'bob-preview-history',
    });
    // The reference is chain state, shared by every account and expensive to
    // rebuild — a removal must never take it with them.
    expect(await store.get(emptyRefStateKey('preview', 'dust'))).toBe('ref-preview-dust');
    expect(await store.get(emptyRefHeightKey('preview'))).toBe('2203416');
  });

  it('still removes the keystore, the meta record and the config entry', async () => {
    const manager = new WalletManager(storage, store);
    await manager.remove('alice');

    expect(await storage.exists('wallets/alice.keystore')).toBe(false);
    expect(await storage.exists('wallets/alice.meta')).toBe(false);
    expect((await manager.list()).map((w) => w.name)).toEqual(['bob']);
  });

  it('rejects an unknown account without clearing anything', async () => {
    await expect(new WalletManager(storage, store).remove('carol')).rejects.toThrow('not found');

    expect(await store.get(syncStateKey('preview', 'alice', 'dust'))).toBe('alice-preview-dust');
  });
});


// Removal is several steps against several stores, and it can be interrupted
// part-way — in the extension the offscreen document hosting it can be closed
// mid-call. What survives an interruption is therefore a design question, not an
// implementation detail: an account still listed in the config whose keystore is
// already deleted is one no passphrase can open, and if it was the only account
// the wallet has no way back in at all, because the "no accounts yet" screen
// only shows for an EMPTY list.

describe('WalletManager.remove leaves a consistent account list', () => {
  const encoderLocal = new TextEncoder();

  async function oneAccount(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.write(
      'config.json',
      encoderLocal.encode(
        JSON.stringify({ activeWallet: 'alice', wallets: ['alice'], defaultNetwork: 'devnet', configVersion: 1 }),
      ),
    );
    await storage.write(
      'wallets/alice.meta',
      encoderLocal.encode(JSON.stringify({ name: 'alice', network: 'devnet', createdAt: '2026-01-01T00:00:00.000Z' })),
    );
    await storage.write('wallets/alice.keystore', encoderLocal.encode('{"ciphertext":"…"}'));
    return storage;
  }

  it('writes the config before deleting the keystore it points at', async () => {
    const storage = await oneAccount();
    storage.ops.length = 0;

    await new WalletManager(storage, new InMemorySyncStateStore()).remove('alice');

    const configWrite = storage.ops.indexOf('write config.json');
    const keystoreDelete = storage.ops.indexOf('delete wallets/alice.keystore');
    expect(configWrite).toBeGreaterThanOrEqual(0);
    expect(keystoreDelete).toBeGreaterThanOrEqual(0);
    // Interrupted between the two, the account is gone from the list and its
    // keystore is orphaned — invisible, and overwritten by the next wallet of
    // that name. The reverse order strands the account instead.
    expect(configWrite).toBeLessThan(keystoreDelete);
  });

  it('removes the last account cleanly, leaving an empty list and no active wallet', async () => {
    const storage = await oneAccount();
    const manager = new WalletManager(storage, new InMemorySyncStateStore());

    await manager.remove('alice');

    expect(await manager.list()).toEqual([]);
    const config = JSON.parse(new TextDecoder().decode((await storage.read('config.json'))!));
    expect(config.wallets).toEqual([]);
    expect(config.activeWallet).toBeNull();
  });

  it('still removes the account when clearing its sync state fails', async () => {
    const storage = await oneAccount();
    // A store that rejects: IndexedDB mid-teardown, a closed connection, a
    // browser that has revoked storage. Cache cleanup is the slowest, most
    // outward-reaching part of a removal and must never strand the account.
    const hostileStore: InMemorySyncStateStore = {
      get: async () => null,
      put: async () => {},
      delete: async () => {
        throw new Error('IndexedDB connection is closing');
      },
    } as unknown as InMemorySyncStateStore;

    await expect(new WalletManager(storage, hostileStore).remove('alice')).resolves.toBeUndefined();

    const config = JSON.parse(new TextDecoder().decode((await storage.read('config.json'))!));
    expect(config.wallets).toEqual([]);
    expect(await storage.exists('wallets/alice.keystore')).toBe(false);
  });
});


// A profile that already reached the stranded state — an entry in the config
// with no keystore — has to be able to recover without developer tools. These
// pin the read paths that make that possible.

describe('WalletManager tolerates a config entry with no keystore', () => {
  const enc = new TextEncoder();

  async function ghostEntry(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.write(
      'config.json',
      enc.encode(
        JSON.stringify({ activeWallet: 'alice', wallets: ['alice'], defaultNetwork: 'devnet', configVersion: 1 }),
      ),
    );
    // Meta may or may not survive; the keystore is what makes an account real.
    await storage.write(
      'wallets/alice.meta',
      enc.encode(JSON.stringify({ name: 'alice', network: 'devnet', createdAt: '2026-01-01T00:00:00.000Z' })),
    );
    return storage;
  }

  it('hides it from list(), so onboarding returns instead of an unopenable Unlock', async () => {
    expect(await new WalletManager(await ghostEntry()).list()).toEqual([]);
  });

  it('lets the same name be created again rather than colliding with the ghost', async () => {
    const manager = new WalletManager(await ghostEntry());

    const created = await manager.generate('alice', 'correct horse battery staple', 'devnet');

    expect(created.name).toBe('alice');
    expect((await manager.list()).map((w) => w.name)).toEqual(['alice']);
  }, 30_000);

  it('lists a name once after reclaiming it, not twice', async () => {
    const storage = await ghostEntry();
    const manager = new WalletManager(storage);

    await manager.generate('alice', 'correct horse battery staple', 'devnet');

    const config = JSON.parse(new TextDecoder().decode((await storage.read('config.json'))!));
    expect(config.wallets).toEqual(['alice']);
  }, 30_000);

  it('still refuses a name whose keystore is really there', async () => {
    const storage = await ghostEntry();
    const manager = new WalletManager(storage);
    await manager.generate('alice', 'correct horse battery staple', 'devnet');

    await expect(manager.generate('alice', 'another passphrase entirely', 'devnet')).rejects.toThrow('already exists');
  }, 60_000);
});
