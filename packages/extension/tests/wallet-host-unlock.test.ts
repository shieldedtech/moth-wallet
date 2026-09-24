import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression guard for the "correct password not recognized" bug. Under Option A
// core's unlock() is seed-free (it derives walletKeys and drops the seed), so
// the offscreen must recover a serializable seed separately — reading the
// now-undefined unlocked.seedHex threw during unlock and surfaced in the UI as a
// wrong password. Core now hands both back from one decrypt (unlockWithSeedHex;
// unlock() + exportSeedHex() ran the KDF twice). Mock the browser layer so the
// unlocked bundle carries NO seedHex (like real core) and assert walletUnlock
// wires seedHex from the value returned beside it.

const { unlockWithSeedHex } = vi.hoisted(() => ({
  unlockWithSeedHex: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { unlockWithSeedHex } }),
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
  summarizeConnectorTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
  designateForDust: vi.fn(),
  dedesignateFromDust: vi.fn(),
  submitFinalizedTransaction: vi.fn(),
  deriveWalletKeys: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  clearEmptyRefCache: vi.fn(),
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
    unlockWithSeedHex.mockReset();
  });

  it('sources seedHex from the single-decrypt unlock, not the seed-free bundle', async () => {
    unlockWithSeedHex.mockResolvedValue({ unlocked: seedFreeUnlocked(), seedHex: 'deadbeef' });

    const unlocked = await walletUnlock('alice', 'pw', 'devnet');

    // The core regression: reading unlocked.seedHex (undefined) would leave this
    // undefined and break every downstream op / show a bogus wrong-password.
    expect(unlocked.seedHex).toBe('deadbeef');
    // One core call — one scrypt derivation — per password entry.
    expect(unlockWithSeedHex).toHaveBeenCalledTimes(1);
    expect(unlockWithSeedHex).toHaveBeenCalledWith('alice', 'pw');
    // Shielded public keys are derived from the recovered seed, not from the bundle.
    expect(unlocked.shieldedCoinPublicKey).toBe('coin:deadbeef');
    expect(unlocked.shieldedEncryptionPublicKey).toBe('enc:deadbeef');
  });

  it('releases the core-unlocked WASM handle after recovering the seed', async () => {
    const lock = vi.fn();
    unlockWithSeedHex.mockResolvedValue({ unlocked: seedFreeUnlocked(lock), seedHex: 'cafe' });

    await walletUnlock('alice', 'pw', 'devnet');

    expect(lock).toHaveBeenCalledTimes(1);
  });
});
