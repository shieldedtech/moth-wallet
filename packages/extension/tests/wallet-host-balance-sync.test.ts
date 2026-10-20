import { describe, it, expect, vi, beforeEach } from 'vitest';

// A dApp can connect and ask for a transaction within a second of the wallet
// starting to sync. A DUST spend made by a wallet that has not finished syncing is
// rejected by the node as InvalidDustSpendProof, so every connector builder —
// balancing, makeTransfer and makeIntent — must wait for the wallet to report
// synced first.

const { startWalletSync, coreBalanceTransaction, buildTransferTransaction, buildSwapIntent } = vi.hoisted(() => ({
  startWalletSync: vi.fn(),
  coreBalanceTransaction: vi.fn(),
  buildTransferTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { list: async () => [] } }),
  startWalletSync,
  balanceTransaction: coreBalanceTransaction,
  buildTransferTransaction,
  buildSwapIntent,
  deriveWalletKeys: () => ({}),
  ensureProverReady: async () => {},
  resolveProverConfig: () => ({ type: 'server', url: 'http://localhost:6300' }),
  IdbSyncStateStore: class {},
  EMPTY_COINS: {},
  // balanceTransaction never reaches these; inert stubs so the module import resolves.
  deriveShieldedPublicKeys: vi.fn(),
  summarizeConnectorTransaction: vi.fn(),
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

import { balanceTransaction, makeIntent, syncStop, transferBuild } from '../lib/offscreen/wallet-host';

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

const SEED = '11'.repeat(32);
const built = { serialize: () => new Uint8Array([0xab]) };

// Each connector builder, with the core call it must not reach before the wallet is synced.
const builders = [
  { name: 'balanceTransaction', core: coreBalanceTransaction, run: () => balanceTransaction(SEED, 'alice', network, 'cd', false, true) },
  { name: 'transferBuild', core: buildTransferTransaction, run: () => transferBuild(SEED, 'alice', network, [], true) },
  { name: 'makeIntent', core: buildSwapIntent, run: () => makeIntent(SEED, 'alice', network, [], [], true) },
];

describe('offscreen connector builders', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    // The host keeps one running wallet per document; start every case from none.
    await syncStop();
    startWalletSync.mockReset();
    for (const { core } of builders) {
      core.mockReset();
      core.mockResolvedValue(built);
    }
  });

  it.each(builders)('$name does not build until the wallet reports synced', async ({ core, run }) => {
    const { wallet, finishSync } = syncingWallet();
    startWalletSync.mockResolvedValue(wallet);

    const result = run();
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core).not.toHaveBeenCalled();

    finishSync();
    await expect(result).resolves.toEqual({ txHex: 'ab' });
    expect(core).toHaveBeenCalledTimes(1);
  });

  it('builds nothing when the wallet never finishes syncing', async () => {
    vi.useFakeTimers();
    startWalletSync.mockResolvedValue(syncingWallet().wallet);

    const result = balanceTransaction(SEED, 'alice', network, 'cd', false, true);
    const settled = expect(result).rejects.toThrow('Wallet sync did not complete in time');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(coreBalanceTransaction).not.toHaveBeenCalled();
  });
});
