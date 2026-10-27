// When the sync engine finds another chain behind the indexer it evicts the cache it wrote on
// the old one (core, sync/chain-identity.ts) and tells its host; the pending-submission notes
// and the Dust-heal stamp this document keeps beside that cache describe the old chain too, so
// syncEnsure's hook drops them and nothing else. The engine checks only at its start, so
// syncEnsure also asks core whether the chain under a running session is still its own before
// handing the session out again, and restarts the engine when it is not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { startWalletSync, deriveWalletKeys, walletsList, cells, readChainIdentity } = vi.hoisted(() => ({
  startWalletSync: vi.fn(),
  deriveWalletKeys: vi.fn((seed: string) => ({ seed }) as never),
  walletsList: vi.fn(async () => [] as Array<{ name: string; birthday?: number }>),
  cells: new Map<string, string>(),
  readChainIdentity: vi.fn(async (): Promise<string | undefined> => undefined),
}));

vi.mock('@shieldedtech/moth-browser', async () => ({
  // The verdict is core's own; the chain itself is this test's to answer.
  observeCacheChain: (await vi.importActual<typeof import('@shieldedtech/moth-wallet/sync/chain-identity')>(
    '@shieldedtech/moth-wallet/sync/chain-identity',
  )).observeCacheChain,
  readChainIdentity,
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
const SEED = 'aa'.repeat(32);
const CHAIN_KEY = 'sync/undeployed/alice/chain.txt';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

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
    readChainIdentity.mockReset().mockResolvedValue(undefined);
    walletsList.mockResolvedValue([]);
    cells.clear();
    host = await import('../lib/offscreen/wallet-host');
    host.setHostEmit(() => {});
  });

  it('hands the engine a hook that drops the notes kept beside the cache, for this wallet on this network alone', async () => {
    startWalletSync.mockImplementationOnce(async () => fakeWallet());
    await host.syncEnsure(SEED, 'alice', NETWORK);

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

describe('syncEnsure handing out a running session', () => {
  let host: typeof import('../lib/offscreen/wallet-host');

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T14:00:00Z'));
    startWalletSync.mockReset().mockImplementation(async () => fakeWallet());
    readChainIdentity.mockReset().mockResolvedValue(NEW);
    walletsList.mockResolvedValue([]);
    cells.clear();
    host = await import('../lib/offscreen/wallet-host');
    host.setHostEmit(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trusts the session for ten seconds after its start, then asks the chain once per ten seconds', async () => {
    cells.set(CHAIN_KEY, NEW);
    const first = await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:09Z'));
    expect(await host.syncEnsure(SEED, 'alice', NETWORK)).toBe(first);
    expect(readChainIdentity).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    expect(await host.syncEnsure(SEED, 'alice', NETWORK)).toBe(first);
    expect(await host.syncEnsure(SEED, 'alice', NETWORK)).toBe(first);
    expect(readChainIdentity).toHaveBeenCalledTimes(1);
    expect(startWalletSync).toHaveBeenCalledTimes(1);
  });

  it('asks once however many callers arrive inside one window', async () => {
    cells.set(CHAIN_KEY, NEW);
    const first = await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    const sessions = await Promise.all([1, 2, 3].map(() => host.syncEnsure(SEED, 'alice', NETWORK)));
    expect(sessions.every((session) => session === first)).toBe(true);
    expect(readChainIdentity).toHaveBeenCalledTimes(1);
  });

  it('stops the session and starts another when the chain was replaced under it, so the start evicts the cache', async () => {
    cells.set(CHAIN_KEY, OLD);
    const first = await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    const second = await host.syncEnsure(SEED, 'alice', NETWORK);
    expect(second).not.toBe(first);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(startWalletSync).toHaveBeenCalledTimes(2);
    // The stamp is the engine's to move, when its start finds the old chain's beside the cache.
    expect(cells.get(CHAIN_KEY)).toBe(OLD);
  });

  it('stamps a session whose start could not ask the chain, and keeps it', async () => {
    const first = await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    expect(await host.syncEnsure(SEED, 'alice', NETWORK)).toBe(first);
    expect(cells.get(CHAIN_KEY)).toBe(NEW);
    expect(startWalletSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when the chain cannot be asked', async () => {
    cells.set(CHAIN_KEY, OLD);
    readChainIdentity.mockResolvedValue(undefined);
    const first = await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    expect(await host.syncEnsure(SEED, 'alice', NETWORK)).toBe(first);
    expect(cells.get(CHAIN_KEY)).toBe(OLD);
    expect(startWalletSync).toHaveBeenCalledTimes(1);
  });

  it('is scoped to the session asked for: another wallet is a fresh start, not a re-check', async () => {
    cells.set(CHAIN_KEY, OLD);
    await host.syncEnsure(SEED, 'alice', NETWORK);
    vi.setSystemTime(new Date('2026-10-27T14:00:11Z'));
    await host.syncEnsure(SEED, 'bob', NETWORK);
    expect(readChainIdentity).not.toHaveBeenCalled();
    expect(startWalletSync).toHaveBeenCalledTimes(2);
  });
});
