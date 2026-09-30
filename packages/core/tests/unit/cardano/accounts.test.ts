import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDerivedCardanoAccount,
  DEFAULT_CARDANO_ACCOUNT,
  getActiveCardanoAccount,
  importCardanoAccount,
  listCardanoAccounts,
  removeCardanoAccount,
  renameCardanoAccount,
  resolveCardanoAccountKey,
  setActiveCardanoAccount,
} from '../../../src/cardano/accounts.js';
import { deriveCardanoAddresses } from '../../../src/cardano/session.js';
import { resolveCardanoNetwork } from '../../../src/cardano/network.js';

const WALLET_MNEMONIC =
  'test test test test test test test test test test test test test test test test test test test test test test test sauce';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

/** In-memory StorageAdapter stand-in. */
function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (k: string) => files.get(k) ?? null,
    write: async (k: string, v: Uint8Array) => { files.set(k, v); },
    delete: async (k: string) => { files.delete(k); },
  };
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => { storage = memoryStorage(); });

describe('the default account', () => {
  it('exists without anything having been written', async () => {
    // A wallet created before Cardano support must not need a migration to
    // have the account it always implicitly had.
    const list = await listCardanoAccounts(storage, 'w');
    expect(list.accounts).toEqual([DEFAULT_CARDANO_ACCOUNT]);
    expect(list.activeId).toBe('default');
    expect(storage.files.size).toBe(0);
  });

  it('survives a corrupt account list rather than locking the user out', async () => {
    storage.files.set('cardano/w/accounts.json', new TextEncoder().encode('{ not json'));
    await expect(listCardanoAccounts(storage, 'w')).resolves.toMatchObject({ activeId: 'default' });
  });
});

describe('addDerivedCardanoAccount', () => {
  it('allocates the next CIP-1852 index and makes it active', async () => {
    const { account } = await addDerivedCardanoAccount(storage, 'w');
    expect(account).toMatchObject({ kind: 'derived', accountIndex: 1, label: 'Account 2' });
    await expect(getActiveCardanoAccount(storage, 'w')).resolves.toMatchObject({ id: account.id });
  });

  it('never reissues the index of a removed account', async () => {
    // Reuse would hand the new account the removed one's address, stake key and
    // any DUST registration attached to it.
    const a = await addDerivedCardanoAccount(storage, 'w'); // index 1
    const b = await addDerivedCardanoAccount(storage, 'w'); // index 2
    await removeCardanoAccount(storage, 'w', b.account.id);
    const c = await addDerivedCardanoAccount(storage, 'w');
    expect(c.account.accountIndex).toBe(3);
    expect(a.account.accountIndex).toBe(1);
  });

  it('gives each index a genuinely different Cardano identity', async () => {
    const config = resolveCardanoNetwork('preview');
    const first = await deriveCardanoAddresses(WALLET_MNEMONIC, config, 0);
    const second = await deriveCardanoAddresses(WALLET_MNEMONIC, config, 1);
    expect(second.address).not.toBe(first.address);
    // Separate stake keys are the point: DUST registration follows the stake
    // credential, so two accounts register independently.
    expect(second.stakeKeyHash).not.toBe(first.stakeKeyHash);
  });
});

describe('importCardanoAccount', () => {
  it('stores the phrase encrypted and returns it only for the right passphrase', async () => {
    const { account } = await importCardanoAccount(storage, 'w', OTHER_MNEMONIC, 'pw', 'Treasury');
    expect(account).toMatchObject({ kind: 'imported', accountIndex: 0, label: 'Treasury' });

    const raw = new TextDecoder().decode(storage.files.get(`cardano/w/keys/${account.id}`)!);
    expect(raw).not.toContain('legal winner'); // never at rest in the clear

    const key = await resolveCardanoAccountKey(storage, 'w', account, null, 'pw');
    expect(key).toEqual({ mnemonic: OTHER_MNEMONIC, accountIndex: 0 });
    await expect(resolveCardanoAccountKey(storage, 'w', account, null, 'wrong')).rejects.toThrow();
  });

  it('refuses an invalid phrase before writing anything', async () => {
    await expect(importCardanoAccount(storage, 'w', 'not a real phrase', 'pw')).rejects.toThrow(/BIP-39/);
    expect(storage.files.size).toBe(0);
  });

  it('is usable without the wallet having a phrase of its own', async () => {
    // The hex-seed case: no derived accounts are possible, but an imported
    // Cardano account is entirely independent of that.
    const { account } = await importCardanoAccount(storage, 'w', OTHER_MNEMONIC, 'pw');
    await expect(resolveCardanoAccountKey(storage, 'w', account, null, 'pw')).resolves.toBeDefined();
  });
});

describe('resolveCardanoAccountKey', () => {
  it('uses the wallet phrase and the account index for derived accounts', async () => {
    const { account } = await addDerivedCardanoAccount(storage, 'w');
    await expect(resolveCardanoAccountKey(storage, 'w', account, WALLET_MNEMONIC)).resolves.toEqual({
      mnemonic: WALLET_MNEMONIC,
      accountIndex: 1,
    });
  });

  it('explains a hex-seed wallet rather than deriving nonsense', async () => {
    await expect(
      resolveCardanoAccountKey(storage, 'w', DEFAULT_CARDANO_ACCOUNT, null),
    ).rejects.toThrow(/no recovery phrase/);
  });
});

describe('removeCardanoAccount', () => {
  it('refuses to remove the last account', async () => {
    await expect(removeCardanoAccount(storage, 'w', 'default')).rejects.toThrow(/only Cardano account/);
  });

  it('destroys an imported phrase and moves the active selection off it', async () => {
    const { account } = await importCardanoAccount(storage, 'w', OTHER_MNEMONIC, 'pw');
    expect(storage.files.has(`cardano/w/keys/${account.id}`)).toBe(true);
    const list = await removeCardanoAccount(storage, 'w', account.id);
    expect(storage.files.has(`cardano/w/keys/${account.id}`)).toBe(false);
    expect(list.activeId).toBe('default');
  });
});

describe('account ids', () => {
  it('rejects one that could escape the wallet namespace', async () => {
    await expect(setActiveCardanoAccount(storage, 'w', '../../other')).rejects.toThrow(/Invalid/);
    await expect(removeCardanoAccount(storage, 'w', '../../other')).rejects.toThrow(/Invalid/);
  });
});

describe('renameCardanoAccount', () => {
  it('renames and rejects an empty label', async () => {
    const list = await renameCardanoAccount(storage, 'w', 'default', '  Savings  ');
    expect(list.accounts[0]!.label).toBe('Savings');
    await expect(renameCardanoAccount(storage, 'w', 'default', '   ')).rejects.toThrow(/empty/);
  });
});

describe('per-wallet isolation', () => {
  it('keeps two wallets’ Cardano accounts apart', async () => {
    await addDerivedCardanoAccount(storage, 'alice');
    await expect(listCardanoAccounts(storage, 'bob')).resolves.toMatchObject({
      accounts: [DEFAULT_CARDANO_ACCOUNT],
    });
  });
});
