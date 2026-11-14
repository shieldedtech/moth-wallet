import { describe, expect, it, vi } from 'vitest';
import { WalletManager } from '../../../src/wallet/manager.js';
import { MemoryStorage } from '../../helpers/memory-storage.js';

// No network is renamed today, so a rename is injected to keep the migration
// rules pinned for the next one. Both ids derive addresses; which ones is arbitrary.
const RETIRED = 'stagenet';
const CURRENT = 'qanet';

vi.mock('../../../src/types/network.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/types/network.js')>();
  return { ...actual, canonicalNetworkId: (id: string) => (id === 'stagenet' ? 'qanet' : id) };
});

describe('WalletManager network rename', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function storageWithRetiredWallet(meta: Record<string, unknown> = {}): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await storage.write(
      'config.json',
      encoder.encode(
        JSON.stringify({ activeWallet: 'bob', wallets: ['bob'], defaultNetwork: RETIRED, configVersion: 1 }),
      ),
    );
    await storage.write(
      'wallets/bob.meta',
      encoder.encode(
        JSON.stringify({
          name: 'bob',
          network: RETIRED,
          createdAt: '2026-01-01T00:00:00.000Z',
          address: `mn_addr_${RETIRED}1example`,
          createdHere: true,
          ...meta,
        }),
      ),
    );
    return storage;
  }

  const storedMeta = async (storage: MemoryStorage, name = 'bob') =>
    JSON.parse(decoder.decode((await storage.read(`wallets/${name}.meta`))!));

  it('reports a wallet stored on the retired id as being on the current one', async () => {
    const manager = new WalletManager(await storageWithRetiredWallet());

    expect((await manager.list())[0]!.network).toBe(CURRENT);
  });

  it('carries the birthday across the rename', async () => {
    // Left under the old key, the wallet has no birthday on the network it now
    // reports, and the pre-seed guard (`reference.height <= birthday`) never passes.
    const storage = await storageWithRetiredWallet({ birthdays: { [RETIRED]: 4200 } });

    await new WalletManager(storage).setNetwork('bob', 'preprod');

    const stored = await storedMeta(storage);
    expect(stored.birthdays[CURRENT]).toBe(4200);
    expect(stored.birthdays[RETIRED]).toBeUndefined();
  });

  it('treats a switch to the retired id as staying put', async () => {
    // Migration is lazy, so the stored bytes keep the old id. The switch must not
    // be taken as a real network change, which discards the address and birthday.
    const storage = await storageWithRetiredWallet({ birthdays: { [RETIRED]: 4200 } });
    const manager = new WalletManager(storage);

    await manager.setNetwork('bob', RETIRED);

    expect((await storedMeta(storage)).birthdays).toEqual({ [RETIRED]: 4200 });
    expect((await manager.list())[0]!.network).toBe(CURRENT);
  });

  it('re-keys a birthday held by a wallet that has since moved elsewhere', async () => {
    // Left under the old key, the return trip looks like a first arrival and is
    // stamped with the tip passed in — a birthday far above the truth.
    const storage = await storageWithRetiredWallet({ network: 'preprod', birthdays: { [RETIRED]: 100 } });

    await new WalletManager(storage).setNetwork('bob', CURRENT, 'addr', 5000);

    expect((await storedMeta(storage)).birthdays).toEqual({ [CURRENT]: 100 });
  });

  it('keeps the lower height when both ids carry a birthday', async () => {
    // Too low only costs scanning; too high skips history.
    const storage = await storageWithRetiredWallet({ birthdays: { [RETIRED]: 100, [CURRENT]: 5000 } });

    await new WalletManager(storage).setNetwork('bob', 'preprod');

    expect((await storedMeta(storage)).birthdays[CURRENT]).toBe(100);
  });

  it('does not report an address whose prefix names the retired id', async () => {
    const [wallet] = await new WalletManager(await storageWithRetiredWallet()).list();

    expect(wallet!.network).toBe(CURRENT);
    expect(wallet!.address).toBe('(locked)');
  });

  it('never persists the retired id for a newly created wallet', async () => {
    const storage = new MemoryStorage();

    await new WalletManager(storage).generate('carol', 'passphrase-long-enough', RETIRED);

    expect((await storedMeta(storage, 'carol')).network).toBe(CURRENT);
  });
});
