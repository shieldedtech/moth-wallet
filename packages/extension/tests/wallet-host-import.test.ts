// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// A wallet created from a raw hex seed has no mnemonic and can never be given
// one — BIP-39's phrase-to-seed step is a one-way KDF — so it was reachable in
// the TUI and CLI but not in the extension, whose import accepted only a
// 24-word phrase. These assert the offscreen host now routes on which artifact
// it was handed, and keeps the two core calls distinct: `import` runs the
// BIP-39 checksum, `importFromSeed` shape-checks the hex.

const { walletsImport, importFromSeed } = vi.hoisted(() => ({
  walletsImport: vi.fn(),
  importFromSeed: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { import: walletsImport, importFromSeed } }),
  deriveShieldedPublicKeys: vi.fn(),
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

import { walletImport } from '../lib/offscreen/wallet-host';

const SEED = 'ab'.repeat(32);

describe('offscreen walletImport routes on the artifact supplied', () => {
  beforeEach(() => {
    walletsImport.mockReset().mockResolvedValue({ name: 'Account-1' });
    importFromSeed.mockReset().mockResolvedValue({ name: 'Account-1' });
  });

  it('sends a phrase to import(), which is the path that checksums it', async () => {
    await walletImport('Account-1', { mnemonic: 'alpha beta gamma' }, 'pw', 'preview');
    expect(walletsImport).toHaveBeenCalledWith('Account-1', 'alpha beta gamma', 'pw', 'preview');
    expect(importFromSeed).not.toHaveBeenCalled();
  });

  it('sends a hex seed to importFromSeed(), never through the phrase path', async () => {
    await walletImport('Account-1', { seed: SEED }, 'pw', 'preview');
    expect(importFromSeed).toHaveBeenCalledWith('Account-1', SEED, 'pw', 'preview');
    expect(walletsImport).not.toHaveBeenCalled();
  });

  it('refuses a call carrying neither, rather than importing an empty phrase', async () => {
    // The protocol type makes this unreachable from typed callers; the guard is
    // for the message boundary, where a payload arrives as plain JSON.
    await expect(walletImport('Account-1', {}, 'pw', 'preview')).rejects.toThrow(
      /either a mnemonic or a seed/,
    );
    expect(walletsImport).not.toHaveBeenCalled();
    expect(importFromSeed).not.toHaveBeenCalled();
  });

  it('prefers the seed when both arrive, and does not double-import', async () => {
    await walletImport('Account-1', { mnemonic: 'alpha', seed: SEED }, 'pw', 'preview');
    expect(importFromSeed).toHaveBeenCalledTimes(1);
    expect(walletsImport).not.toHaveBeenCalled();
  });
});
