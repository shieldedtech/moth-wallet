// When the sync engine finds another chain behind the indexer it evicts the cache it wrote on
// the old one (core, sync/chain-identity.ts) and tells its host; the pending-submission notes
// and the Dust-heal stamp this document keeps beside that cache describe the old chain too, so
// syncEnsure's hook drops them and nothing else.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { startWalletSync, deriveWalletKeys, walletsList, cells } = vi.hoisted(() => ({
  startWalletSync: vi.fn(),
  deriveWalletKeys: vi.fn((seed: string) => ({ seed }) as never),
  walletsList: vi.fn(async () => [] as Array<{ name: string; birthday?: number }>),
  cells: new Map<string, string>(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { list: walletsList } }),
  startWalletSync,
  deriveWalletKeys,
  // One store behind every `new IdbSyncStateStore()` the host makes, as IndexedDB is.
  IdbSyncStateStore: class {
    get(key: string) {
      return Promise.resolve(cells.get(key) ?? null);
    }
    put(key: string, value: string) {
      cells.set(key, value);
      return Promise.resolve();
    }
    delete(key: string) {
      cells.delete(key);
      return Promise.resolve();
    }
  },
  EMPTY_COINS: { shielded: [], unshielded: [], dust: [] },
  buildTransferTransaction: vi.fn(),
  estimateTransferFee: vi.fn(),
  balanceTransaction: vi.fn(),
  summarizeConnectorTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
  designateForDust: vi.fn(),
  dedesignateFromDust: vi.fn(),
  submitFinalizedTransaction: vi.fn(),
  deriveShieldedPublicKeys: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  clearEmptyRefCache: vi.fn(),
  warmEmptyRefCache: vi.fn(),
  preseedReferenceStatus: vi.fn(),
  DustRegistrationNotYetError: class extends Error {},
  signMessage: vi.fn(),
  deriveAppSecret: vi.fn(),
  deriveActivity: vi.fn(),
  createProvingProvider: vi.fn(),
  ensureProverReady: vi.fn(),
  resolveProverConfig: vi.fn(),
  submitWithHealthTracking: vi.fn(),
  dustSpendHealthTracker: { note: vi.fn() },
  diagnoseSubmissionFailure: vi.fn(),
}));

vi.mock('./../lib/offscreen/bundled-preseed', () => ({
  installBundledReference: vi.fn(async () => false),
  hasBundledReference: vi.fn(async () => false),
}));
vi.mock('./../lib/offscreen/relay-socket', () => ({
  setRelayUrl: vi.fn(),
  relayRetry: (fn: unknown) => fn,
}));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({}));

import { submissionsKey } from '../lib/offscreen/submissions';
import { dustHealKey } from '../lib/offscreen/dust-heal';
import '../lib/offscreen/wallet-host';

const NETWORK = { id: 'undeployed', nodeUrl: 'ws://localhost:9944', indexerUrl: 'http://localhost:8088/api/v4/graphql' } as never;

function fakeWallet() {
  const balances = { unshielded: {}, shielded: {}, dust: 0n, synced: true };
  return {
    facade: {},
    balances,
    stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => balances),
    subscribe: () => () => {},
  };
}

describe('syncEnsure on a replaced chain', () => {
  let host: typeof import('../lib/offscreen/wallet-host');

  beforeEach(async () => {
    vi.resetModules();
    startWalletSync.mockReset();
    walletsList.mockResolvedValue([]);
    cells.clear();
    host = await import('../lib/offscreen/wallet-host');
    host.setHostEmit(() => {});
  });

  it('hands the engine a hook that drops the notes kept beside the cache, for this wallet on this network alone', async () => {
    startWalletSync.mockImplementationOnce(async () => fakeWallet());
    await host.syncEnsure('aa'.repeat(32), 'alice', NETWORK);

    const options = startWalletSync.mock.calls[0]![6] as { onChainReplaced?: () => Promise<void> };
    expect(typeof options.onChainReplaced).toBe('function');

    cells.set(submissionsKey('undeployed', 'alice'), '[]');
    cells.set(dustHealKey('undeployed', 'alice'), '1');
    cells.set(submissionsKey('preprod', 'alice'), '[]');
    cells.set(dustHealKey('undeployed', 'bob'), '1');
    cells.set('sync/undeployed/alice/chain.txt', 'kept by core, not by the host');

    await options.onChainReplaced!();

    expect(cells.has(submissionsKey('undeployed', 'alice'))).toBe(false);
    expect(cells.has(dustHealKey('undeployed', 'alice'))).toBe(false);
    expect(cells.has(submissionsKey('preprod', 'alice'))).toBe(true);
    expect(cells.has(dustHealKey('undeployed', 'bob'))).toBe(true);
    expect(cells.has('sync/undeployed/alice/chain.txt')).toBe(true);
  });
});
