import { beforeAll, describe, expect, it } from 'vitest';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { WalletManager } from '../../../src/wallet/manager.js';
import { deriveAllAddressesFromSeed } from '../../../src/wallet/address.js';
import { MemoryStorage } from '../../helpers/memory-storage.js';
import { initLedger } from '../../../src/ledger/index.js';

// WalletManager reaches deriveWalletKeys, which takes its ledger from the seam.
beforeAll(async () => {
  await initLedger('v8');
});

describe('WalletManager.setLabel', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function storageWithWallet(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.write(
      'config.json',
      encoder.encode(JSON.stringify({ activeWallet: 'alice', wallets: ['alice'], defaultNetwork: 'devnet', configVersion: 1 })),
    );
    await storage.write(
      'wallets/alice.meta',
      encoder.encode(
        JSON.stringify({
          name: 'alice',
          network: 'devnet',
          createdAt: '2026-01-01T00:00:00.000Z',
          address: 'mn_unshielded_devnet',
        }),
      ),
    );
    return storage;
  }

  it('stores a trimmed label and returns it from list()', async () => {
    const storage = await storageWithWallet();
    const manager = new WalletManager(storage);

    await manager.setLabel('alice', '  Savings  ');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/alice.meta'))!));
    expect(stored.label).toBe('Savings');
    expect(stored.name).toBe('alice');

    const [wallet] = await manager.list();
    expect(wallet).toMatchObject({ name: 'alice', label: 'Savings' });
  });

  it('clears the label when set to whitespace', async () => {
    const storage = await storageWithWallet();
    const manager = new WalletManager(storage);

    await manager.setLabel('alice', 'Savings');
    await manager.setLabel('alice', '   ');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/alice.meta'))!));
    expect('label' in stored).toBe(false);
  });

  it('rejects unknown wallets', async () => {
    const storage = await storageWithWallet();
    await expect(new WalletManager(storage).setLabel('bob', 'Savings')).rejects.toThrow('Wallet "bob" not found');
  });

  it('survives a network move', async () => {
    const storage = await storageWithWallet();
    const manager = new WalletManager(storage);

    await manager.setLabel('alice', 'Savings');
    await manager.setNetwork('alice', 'preview', 'mn_unshielded_preview');

    const [wallet] = await manager.list();
    expect(wallet).toMatchObject({ network: 'preview', label: 'Savings' });
  });
});

describe('WalletManager.setNetwork', () => {
  // This used to assert that the old chain's birthday was DROPPED. That was the
  // defect: a wallet left with no birthday anywhere can never satisfy the
  // pre-seed guard (`reference.height <= birthday`), so every sync after a
  // network switch walked from genesis — 78.6 min on preprod. The height is now
  // kept, filed under the network it belongs to, since heights are per-chain
  // rather than meaningless. See network-birthdays.test.ts for the full rules.
  it('moves the network-scoped metadata and files the old birthday under its own network', async () => {
    const storage = new MemoryStorage();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    await storage.write(
      'wallets/alice.meta',
      encoder.encode(
        JSON.stringify({
          name: 'alice',
          network: 'devnet',
          createdAt: '2026-01-01T00:00:00.000Z',
          address: 'mn_unshielded_devnet',
          birthday: 123_456,
        }),
      ),
    );

    await new WalletManager(storage).setNetwork('alice', 'preview', 'mn_unshielded_preview');

    const stored = await storage.read('wallets/alice.meta');
    expect(JSON.parse(decoder.decode(stored!))).toEqual({
      name: 'alice',
      network: 'preview',
      createdAt: '2026-01-01T00:00:00.000Z',
      address: 'mn_unshielded_preview',
      // devnet's height survives the move; preview gains none, because this
      // wallet predates `createdHere` and so reads as imported.
      birthdays: { devnet: 123_456 },
    });
  });
});

// Regression guard for the extension key-holder path. Option A makes unlock()
// seed-free (walletKeys derived, seed dropped), so the offscreen recovers a
// serializable seed via exportSeedHex to rebuild the key bundle after Chrome
// tears the offscreen down. A regression here surfaced as "correct password
// not recognized" because the offscreen was reading a now-undefined
// unlocked.seedHex during unlock.
describe('WalletManager.exportSeedHex', () => {
  const PASS = 'correct horse battery staple';

  // These derive keys with scrypt at the v2 parameters, so they inherit the
  // project's raised testTimeout rather than carrying their own: a per-test
  // literal overrides the config and fails a --coverage run, where the same
  // derivation takes several times longer.
  it('round-trips: the exported seed reconstructs the wallet it was created with', async () => {
    const manager = new WalletManager(new MemoryStorage());
    const created = await manager.generate('alice', PASS, 'devnet');

    const seedHex = await manager.exportSeedHex('alice', PASS);

    expect(seedHex).toMatch(/^[0-9a-f]+$/);
    // The seed must derive exactly the addresses generate() produced — this is
    // what lets the offscreen rebuild walletKeys from the re-supplied seed.
    expect(deriveAllAddressesFromSeed(seedHex)).toEqual(created.addresses);
  });

  it('keeps unlock() seed-free while exportSeedHex supplies the seed (Option A invariant)', async () => {
    const manager = new WalletManager(new MemoryStorage());
    await manager.generate('alice', PASS, 'devnet');

    const unlocked = await manager.unlock('alice', PASS);
    // If seedHex ever reappears on the unlocked object, the offscreen's
    // exportSeedHex detour is no longer needed — revisit walletUnlock.
    expect((unlocked as unknown as { seedHex?: string }).seedHex).toBeUndefined();
    expect(unlocked.walletKeys).toBeDefined();
    expect(unlocked.walletKeys.shieldedSecretKeys).toBeDefined();
    unlocked.lock();

    const seedHex = await manager.exportSeedHex('alice', PASS);
    expect(deriveAllAddressesFromSeed(seedHex)).toEqual(unlocked.addresses);
  });

  it('rejects the wrong passphrase rather than returning a bogus seed', async () => {
    const manager = new WalletManager(new MemoryStorage());
    await manager.generate('alice', PASS, 'devnet');

    await expect(manager.exportSeedHex('alice', 'not the passphrase')).rejects.toThrow();
  });

  it('rejects an unknown wallet', async () => {
    const manager = new WalletManager(new MemoryStorage());
    await expect(manager.exportSeedHex('nobody', PASS)).rejects.toThrow('Wallet "nobody" not found');
  });
});

describe('WalletManager keystore KDF upgrade', () => {
  const PASS = 'correct horse battery staple';
  const KEYSTORE_KEY = 'wallets/carol.keystore';

  // Three scrypt derivations at the v2 parameters plus one at v1, so this is the
  // slowest test in the suite and the first to fail when instrumentation slows
  // it down. It takes the timeout from the config rather than a literal of its
  // own, which would override both the project setting and the larger bound the
  // coverage run passes on the command line.
  it('upgrades a v1 keystore in place on first unlock, at the key unlock() reads, exactly once',
    async () => {
      const storage = new MemoryStorage();
      const manager = new WalletManager(storage);
      const created = await manager.generate('carol', PASS, 'devnet');

      // Forge the pre-upgrade on-disk state: the same mnemonic sealed with the
      // v1 scrypt parameters (N=2^15) — exactly what a wallet created before
      // the KDF bump has at `wallets/<name>.keystore`. Built from primitives
      // on purpose, so this test pins the v1 format independently of
      // keystore.ts (which can only produce the current version).
      const encoder = new TextEncoder();
      const salt = randomBytes(32);
      const nonce = randomBytes(12);
      const key = scrypt(encoder.encode(PASS), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
      const sealed = chacha20poly1305(key, nonce).encrypt(encoder.encode(created.mnemonic));
      const v1 = {
        version: 1,
        algorithm: 'chacha20-poly1305',
        salt,
        nonce,
        ciphertext: sealed.subarray(0, sealed.length - 16),
        tag: sealed.subarray(sealed.length - 16),
      };
      await storage.write(KEYSTORE_KEY, encoder.encode(JSON.stringify(v1)));

      const keystoreWrites: string[] = [];
      const originalWrite = storage.write.bind(storage);
      storage.write = async (writeKey: string, data: Uint8Array) => {
        keystoreWrites.push(writeKey);
        return originalWrite(writeKey, data);
      };

      // First unlock decrypts with the v1 parameters, then transparently
      // re-encrypts at the current version — and at `wallets/<name>.keystore`,
      // the key unlock() reads. (The bug this guards against saved the upgrade
      // to a phantom key, so it never persisted and re-ran on every unlock.)
      const first = await manager.unlock('carol', PASS);
      expect(first.addresses).toEqual(created.addresses);
      expect(keystoreWrites).toContain(KEYSTORE_KEY);

      const upgraded = JSON.parse(
        new TextDecoder().decode((await storage.read(KEYSTORE_KEY))!),
      ) as { version: number };
      expect(upgraded.version).toBe(2);

      // Second unlock opens the upgraded keystore and must not rewrite it.
      keystoreWrites.length = 0;
      const second = await manager.unlock('carol', PASS);
      expect(second.addresses).toEqual(created.addresses);
      expect(keystoreWrites).not.toContain(KEYSTORE_KEY);
    });
});

// `local` was a duplicate preset for the same local devnet stack as `undeployed`,
// on a node port the stack does not listen on. Wallets created while it was
// offered still carry it, and on unlock a wallet's own network becomes the
// wallet-wide selection — so a stale id here reasserts itself over a migrated
// selection every time the wallet is opened.
describe('WalletManager legacy network ids', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function storageWithLegacyWallet(meta: Record<string, unknown> = {}): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.write(
      'config.json',
      encoder.encode(
        JSON.stringify({ activeWallet: 'bob', wallets: ['bob'], defaultNetwork: 'local', configVersion: 1 }),
      ),
    );
    await storage.write(
      'wallets/bob.meta',
      encoder.encode(
        JSON.stringify({
          name: 'bob',
          network: 'local',
          createdAt: '2026-01-01T00:00:00.000Z',
          address: 'mn_addr_local1example',
          createdHere: true,
          ...meta,
        }),
      ),
    );
    return storage;
  }

  it('reports a wallet stored on local as being on undeployed', async () => {
    const manager = new WalletManager(await storageWithLegacyWallet());

    const [wallet] = await manager.list();

    expect(wallet!.network).toBe('undeployed');
  });

  it('carries the birthday across the rename', async () => {
    // Birthdays are keyed by network id and gate the pre-seed shortcut
    // (`reference.height <= birthday`). Left under the old key, the wallet has
    // no birthday on the network it now reports, and every sync walks genesis.
    const storage = await storageWithLegacyWallet({ birthdays: { local: 4200 } });
    const manager = new WalletManager(storage);

    await manager.setNetwork('bob', 'preprod');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/bob.meta'))!));
    expect(stored.birthdays.undeployed).toBe(4200);
    expect(stored.birthdays.local).toBeUndefined();
  });

  it('treats a switch to the retired id as staying put', async () => {
    // Migration is lazy: the record on disk is rewritten only when something
    // else is already saving it, so the stored bytes keep the old id and the
    // wallet is still reported on the new one. What must NOT happen is the
    // switch being taken as a real network change, which discards the address
    // and the birthday.
    const storage = await storageWithLegacyWallet({ birthdays: { local: 4200 } });
    const manager = new WalletManager(storage);

    await manager.setNetwork('bob', 'local');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/bob.meta'))!));
    expect(stored.birthdays).toEqual({ local: 4200 });
    expect((await manager.list())[0]!.network).toBe('undeployed');
  });

  it('re-keys a birthday held by a wallet that has since moved elsewhere', async () => {
    // The re-key must not be gated on the wallet's OWN network having been
    // renamed. This wallet was created on the local stack and has since moved to
    // preprod, so it still holds the old key while reporting preprod. Left
    // there, the return trip below looks like a first arrival and gets stamped
    // with the tip passed in — a birthday far above the truth, which lets the
    // pre-seed guard accept a reference newer than the wallet's own history.
    const storage = await storageWithLegacyWallet({ network: 'preprod', birthdays: { local: 100 } });
    const manager = new WalletManager(storage);

    await manager.setNetwork('bob', 'undeployed', 'addr', 5000);

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/bob.meta'))!));
    expect(stored.birthdays).toEqual({ undeployed: 100 });
  });

  it('keeps the lower height when both names carry a birthday', async () => {
    // Both `local` and `undeployed` were offered at once, so a wallet can hold a
    // birthday under each. Insertion order deciding it would pick either; lower
    // is the safe direction, because too low only costs scanning.
    const storage = await storageWithLegacyWallet({ birthdays: { local: 100, undeployed: 5000 } });
    const manager = new WalletManager(storage);

    await manager.setNetwork('bob', 'preprod');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/bob.meta'))!));
    expect(stored.birthdays.undeployed).toBe(100);
  });

  it('does not report an address whose prefix names the old network', async () => {
    // `mn_addr_local1…` shown against a wallet reported on `undeployed` is an
    // invitation to receive on the wrong encoding. "(locked)" is honest and is
    // already what the list renders for a wallet with no stored address.
    const manager = new WalletManager(await storageWithLegacyWallet());

    const [wallet] = await manager.list();

    expect(wallet!.network).toBe('undeployed');
    expect(wallet!.address).not.toContain('local');
    expect(wallet!.address).toBe('(locked)');
  });

  it('never persists the retired id for a newly created wallet', async () => {
    const storage = new MemoryStorage();
    const manager = new WalletManager(storage);

    await manager.generate('carol', 'passphrase-long-enough', 'local');

    const stored = JSON.parse(decoder.decode((await storage.read('wallets/carol.meta'))!));
    expect(stored.network).toBe('undeployed');
  });
});
