import { describe, it, expect, vi, beforeEach } from 'vitest';

// A dApp can connect and ask for a balance within a second of the wallet starting
// to sync. A DUST spend balanced by a wallet that has not finished syncing is
// rejected by the node as InvalidDustSpendProof, so the connector's balancing must
// wait for the wallet to report synced first.

const { startWalletSync, coreBalanceTransaction } = vi.hoisted(() => ({
  startWalletSync: vi.fn(),
  coreBalanceTransaction: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { list: async () => [] } }),
  startWalletSync,
  balanceTransaction: coreBalanceTransaction,
  deriveWalletKeys: () => ({}),
  ensureProverReady: async () => {},
  resolveProverConfig: () => ({ type: 'server', url: 'http://localhost:6300' }),
  IdbSyncStateStore: class {},
  EMPTY_COINS: {},
  // balanceTransaction never reaches these; inert stubs so the module import resolves.
  deriveShieldedPublicKeys: vi.fn(),
  buildTransferTransaction: vi.fn(),
  summarizeConnectorTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
  submitFinalizedTransaction: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  clearEmptyRefCache: vi.fn(),
  warmEmptyRefCache: vi.fn(),
  preseedReferenceStatus: vi.fn(),
  DustRegistrationNotYetError: class extends Error {},
  signMessage: vi.fn(),
  deriveActivity: vi.fn(),
  createProvingProvider: vi.fn(),
  setWasmProvingProviderFactory: vi.fn(),
  submitWithHealthTracking: vi.fn(),
  dustSpendHealthTracker: vi.fn(),
  diagnoseSubmissionFailure: vi.fn(),
}));

vi.mock('../lib/offscreen/bundled-preseed', () => ({
  installBundledReference: async () => {},
  hasBundledReference: () => false,
}));

import { balanceTransaction } from '../lib/offscreen/wallet-host';

const network = { id: 'undeployed', nodeUrl: 'ws://localhost:9944', indexerUrl: 'http://localhost:8088' } as never;

/** A wallet whose sync engine has started but not caught up. */
function syncingWallet() {
  const listeners = new Set<(balances: { synced: boolean }) => void>();
  const wallet = {
    facade: {},
    balances: { synced: false },
    subscribe(listener: (balances: { synced: boolean }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: async () => {},
  };
  const finishSync = () => {
    wallet.balances = { synced: true };
    for (const listener of [...listeners]) listener(wallet.balances);
  };
  return { wallet, finishSync };
}

describe('offscreen balanceTransaction', () => {
  beforeEach(() => {
    startWalletSync.mockReset();
    coreBalanceTransaction.mockReset();
    coreBalanceTransaction.mockResolvedValue({ serialize: () => new Uint8Array([0xab]) });
  });

  it('does not balance until the wallet reports synced', async () => {
    const { wallet, finishSync } = syncingWallet();
    startWalletSync.mockResolvedValue(wallet);

    const balanced = balanceTransaction('11'.repeat(32), 'alice', network, 'cd', false, true);
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coreBalanceTransaction).not.toHaveBeenCalled();

    finishSync();
    await expect(balanced).resolves.toEqual({ txHex: 'ab' });
    expect(coreBalanceTransaction).toHaveBeenCalledTimes(1);
  });
});
