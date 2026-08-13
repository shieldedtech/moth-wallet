import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression guard for the "correct password not recognized" bug. Under Option A
// core's unlock() is seed-free (it derives walletKeys and drops the seed), so
// the offscreen must recover a serializable seed via exportSeedHex — reading the
// now-undefined unlocked.seedHex threw during unlock and surfaced in the UI as a
// wrong password. Mock the browser layer so unlock() returns NO seedHex (like
// real core) and assert walletUnlock still wires seedHex from exportSeedHex.

const { unlock, exportSeedHex } = vi.hoisted(() => ({
  unlock: vi.fn(),
  exportSeedHex: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { unlock, exportSeedHex } }),
  deriveShieldedPublicKeys: (seedHex: string) => ({
    coinPublicKey: `coin:${seedHex}`,
    encryptionPublicKey: `enc:${seedHex}`,
  }),
  // walletUnlock never calls these; provide inert stubs so the module import
  // (which destructures them) resolves.
  startWalletSync: vi.fn(),
  buildTransferTransaction: vi.fn(),
  estimateTransferFee: vi.fn(),
  balanceTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
  designateForDust: vi.fn(),
  dedesignateFromDust: vi.fn(),
  submitFinalizedTransaction: vi.fn(),
  deriveWalletKeys: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  signMessage: vi.fn(),
  deriveActivity: vi.fn(),
  IdbSyncStateStore: class {},
  createProvingProvider: vi.fn(),
  ensureProverReady: vi.fn(),
  resolveProverConfig: vi.fn(),
  EMPTY_COINS: {},
}));

import { walletUnlock } from '../lib/offscreen/wallet-host';

const seedFreeUnlocked = (lock = vi.fn()) => ({
  name: 'alice',
  label: 'Alice',
  network: 'devnet',
  address: 'mn_unshielded_devnet',
  addresses: { nightExternal: { bech32m: { devnet: 'mn_unshielded_devnet' } } },
  // Option A: walletKeys present, seedHex ABSENT.
  walletKeys: { shieldedSecretKeys: {}, dustSecretKey: {}, nightExternalKey: new Uint8Array() },
  keys: {},
  lock,
});

describe('offscreen walletUnlock (Option A key-holder)', () => {
  beforeEach(() => {
    unlock.mockReset();
    exportSeedHex.mockReset();
  });

  it('sources seedHex from exportSeedHex, not the seed-free unlock() result', async () => {
    unlock.mockResolvedValue(seedFreeUnlocked());
    exportSeedHex.mockResolvedValue('deadbeef');

    const unlocked = await walletUnlock('alice', 'pw', 'devnet');

    // The core regression: reading unlocked.seedHex (undefined) would leave this
    // undefined and break every downstream op / show a bogus wrong-password.
    expect(unlocked.seedHex).toBe('deadbeef');
    expect(exportSeedHex).toHaveBeenCalledWith('alice', 'pw');
    // Shielded public keys are derived from the recovered seed, not from unlock().
    expect(unlocked.shieldedCoinPublicKey).toBe('coin:deadbeef');
    expect(unlocked.shieldedEncryptionPublicKey).toBe('enc:deadbeef');
  });

  it('releases the core-unlocked WASM handle after recovering the seed', async () => {
    const lock = vi.fn();
    unlock.mockResolvedValue(seedFreeUnlocked(lock));
    exportSeedHex.mockResolvedValue('cafe');

    await walletUnlock('alice', 'pw', 'devnet');

    expect(lock).toHaveBeenCalledTimes(1);
  });
});
