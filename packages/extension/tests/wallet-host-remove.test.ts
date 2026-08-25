import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncStateKey } from '@shieldedtech/moth-wallet/sync/sync-store';
import { submissionsKey } from '../lib/offscreen/submissions';
import { dustHealKey } from '../lib/offscreen/dust-heal';

// Removing an account must leave nothing of it behind in this profile: the
// account a user re-adds to escape a stuck sync has to start fresh, and a
// re-added NAME may hold a different seed entirely (#90).
//
// Two failures met here, neither visible in the UI:
//  - core cleaned a sync store the browser never writes to, so IndexedDB kept
//    the removed account's state (covered in core: remove-sync-state.test.ts —
//    this suite covers the store actually being handed over, and the rest).
//  - the engine flushes its final state when it stops, and lockNow() fires that
//    teardown without awaiting it. A removal that deletes first has the state
//    written straight back, which is why the removed account's dust cursor came
//    back to the event.

// One fake IndexedDB-backed sync store shared by every `new IdbSyncStateStore()`
// in the module under test, mirroring how they all address one database.
const entries = new Map<string, string>();

const { remove, list, stop, subscribe } = vi.hoisted(() => ({
  remove: vi.fn(),
  list: vi.fn(),
  stop: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { remove, list } }),
  startWalletSync: () => Promise.resolve({ stop, subscribe, balances: {}, refresh: vi.fn() }),
  IdbSyncStateStore: class {
    async get(key: string) {
      return entries.get(key) ?? null;
    }
    async put(key: string, value: string) {
      entries.set(key, value);
    }
    async delete(key: string) {
      entries.delete(key);
    }
  },
  deriveWalletKeys: () => ({ shieldedSecretKeys: {}, dustSecretKey: {}, nightExternalKey: new Uint8Array() }),
  // Untouched by these paths; present so the module's imports resolve.
  buildTransferTransaction: vi.fn(),
  estimateTransferFee: vi.fn(),
  balanceTransaction: vi.fn(),
  buildSwapIntent: vi.fn(),
  designateForDust: vi.fn(),
  dedesignateFromDust: vi.fn(),
  submitFinalizedTransaction: vi.fn(),
  deriveShieldedPublicKeys: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  signMessage: vi.fn(),
  deriveActivity: vi.fn(),
  createProvingProvider: vi.fn(),
  ensureProverReady: vi.fn(),
  resolveProverConfig: vi.fn(),
  EMPTY_COINS: {},
}));

// The bundled reference is fetched from the package; there is no fetch here.
vi.mock('../lib/offscreen/bundled-preseed', () => ({
  installBundledReference: vi.fn(async () => false),
  hasBundledReference: vi.fn(() => false),
}));

type Host = typeof import('../lib/offscreen/wallet-host');

const NETWORK = {
  id: 'devnet',
  nodeUrl: 'ws://localhost:9944',
  indexerUrl: 'http://localhost:8088/api/v4/graphql',
  prover: { type: 'server', url: 'http://localhost:6300' },
} as unknown as Parameters<Host['syncEnsure']>[2];

const PARTS = ['shielded', 'unshielded', 'dust', 'history'] as const;

function seedState(wallet: string, network = 'devnet'): void {
  for (const part of PARTS) entries.set(syncStateKey(network, wallet, part), `${wallet}-${part}`);
  entries.set(submissionsKey(network, wallet), '[{"hash":"0xabc"}]');
  entries.set(dustHealKey(network, wallet), '1782127919459');
}

describe('offscreen walletRemove', () => {
  let host: Host;

  beforeEach(async () => {
    // The host keeps the running engine in module state, so each case gets its
    // own copy — otherwise "no sync was ever started" inherits the previous
    // case's engine.
    vi.resetModules();
    host = await import('../lib/offscreen/wallet-host');
    entries.clear();
    remove.mockReset().mockResolvedValue(undefined);
    list.mockReset().mockResolvedValue([{ name: 'alice', birthday: 2_087_202 }]);
    stop.mockReset().mockResolvedValue(undefined);
    subscribe.mockReset().mockReturnValue(() => {});
  });

  it('stops the account sync before core deletes its state', async () => {
    await host.syncEnsure('ab'.repeat(32), 'alice', NETWORK);
    seedState('alice');

    await host.walletRemove('alice', 'devnet');

    expect(stop).toHaveBeenCalledTimes(1);
    // The whole point: the engine's final write lands before the delete, not
    // after it. Reversed, the removed account's state is restored on re-add.
    expect(stop.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);
    expect(remove).toHaveBeenCalledWith('alice');
  });

  it('deletes the per-account keys core knows nothing about', async () => {
    seedState('alice');

    await host.walletRemove('alice', 'devnet');

    // Submission notes would show the removed account's pending rows under the
    // re-added one; the dust stamp would deny it a repair it never had.
    expect(entries.has(submissionsKey('devnet', 'alice'))).toBe(false);
    expect(entries.has(dustHealKey('devnet', 'alice'))).toBe(false);
  });

  it('clears those keys on the account\'s own network, not just the active one', async () => {
    // The accounts list shows every account in the profile, so an account
    // recorded on preview can be removed while devnet is the active network.
    list.mockResolvedValue([{ name: 'alice', network: 'preview', birthday: 2_087_202 }]);
    seedState('alice', 'preview');

    await host.walletRemove('alice', 'devnet');

    expect(entries.has(submissionsKey('preview', 'alice'))).toBe(false);
    expect(entries.has(dustHealKey('preview', 'alice'))).toBe(false);
  });

  it('leaves another account alone, including its running sync', async () => {
    await host.syncEnsure('ab'.repeat(32), 'alice', NETWORK);
    seedState('alice');
    seedState('bob');

    await host.walletRemove('bob', 'devnet');

    // Removing bob must not stop the account that is actually syncing.
    expect(stop).not.toHaveBeenCalled();
    expect(entries.get(submissionsKey('devnet', 'alice'))).toBe('[{"hash":"0xabc"}]');
    expect(entries.get(dustHealKey('devnet', 'alice'))).toBe('1782127919459');
  });

  it('still removes an account whose sync was never started', async () => {
    seedState('alice');

    await expect(host.walletRemove('alice', 'devnet')).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith('alice');
    expect(stop).not.toHaveBeenCalled();
  });
});
