// Cross-wallet balance bleed on a mid-start wallet switch.
//
// syncEnsure sets `current` BEFORE awaiting the sync start, so a switch during
// that await supersedes the record. When the first start finally resolves, it
// subscribes unconditionally — and core's `subscribe` invokes the callback
// immediately with the wallet's own balances (sync/wallet-sync.ts) — so the
// superseded wallet emits one `os/eventBalances` into the shared channel after
// the user has already moved on. The panel shows the wrong wallet's balance.
//
// The `if (current?.key === key)` guard on the following line shows the author
// knew `current` could change; the emission itself was never guarded, and the
// unsubscribe handle is dropped rather than called when the guard fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { startWalletSync, deriveWalletKeys, walletsList } = vi.hoisted(() => ({
  startWalletSync: vi.fn(),
  deriveWalletKeys: vi.fn((seed: string) => ({ seed }) as never),
  walletsList: vi.fn(async () => [] as Array<{ name: string; birthday?: number }>),
}));

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { list: walletsList } }),
  startWalletSync,
  deriveWalletKeys,
  IdbSyncStateStore: class {},
  EMPTY_COINS: { shielded: [], unshielded: [], dust: [] },
  // Inert stubs: wallet-host destructures these at module load.
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
vi.mock('./../lib/messaging/balances-json', () => ({
  // Identify the emitting wallet by its NIGHT balance, which is all this needs.
  serializeBalances: (b: { unshielded: Record<string, bigint> }) => JSON.stringify({ night: String(b.unshielded.night) }),
}));

const NETWORK = { id: 'preprod', nodeUrl: 'https://rpc.preprod.example', indexerUrl: 'https://ix.example' } as never;

/** A controllable stand-in for core's SyncedWallet, matching the two behaviours
 *  that matter: subscribe() emits immediately, stop() kills the feed. */
function fakeWallet(night: bigint) {
  const subscribers: Array<(b: unknown) => void> = [];
  let stopped = false;
  const balances = { unshielded: { night }, shielded: {}, dust: 0n, synced: true };
  return {
    wallet: {
      facade: {},
      balances,
      stop: vi.fn(async () => { stopped = true; subscribers.length = 0; }),
      refresh: vi.fn(async () => balances),
      subscribe: (cb: (b: unknown) => void) => {
        subscribers.push(cb);
        cb(balances); // core does this synchronously — the whole point
        return () => {
          const i = subscribers.indexOf(cb);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
    },
    /** A later sync update, as the live engine would produce. */
    push: () => { if (!stopped) for (const cb of [...subscribers]) cb(balances); },
    isStopped: () => stopped,
  };
}

describe('balance emissions across a mid-start wallet switch', () => {
  let host: typeof import('../lib/offscreen/wallet-host');
  let emitted: Array<{ event: string; data: unknown }>;

  beforeEach(async () => {
    vi.resetModules();
    startWalletSync.mockReset();
    walletsList.mockResolvedValue([]);
    emitted = [];
    host = await import('../lib/offscreen/wallet-host');
    host.setHostEmit((event, data) => emitted.push({ event, data }));
  });

  const nights = () =>
    emitted
      .filter((e) => e.event === 'os/eventBalances')
      .map((e) => JSON.parse(String(e.data)).night as string);

  it('does not emit the superseded wallet balance after a switch', async () => {
    const treasury = fakeWallet(944n);
    const consumer = fakeWallet(942n);

    // Treasury's start hangs; the user switches before it resolves.
    let releaseTreasury!: (w: unknown) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((res) => { releaseTreasury = res; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    // syncEnsure awaits syncStop, the bundled reference and the wallet list
    // before it reaches startWalletSync; the switch has to land after that.
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));

    startWalletSync.mockImplementationOnce(async () => consumer.wallet);
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    // Treasury comes up after the switch.
    releaseTreasury(treasury.wallet);
    await treasuryStart.catch(() => {});
    await consumerStart;
    await vi.waitFor(() => expect(treasury.wallet.stop).toHaveBeenCalled());

    expect(nights()).not.toContain('944');
  });

  it('leaves no live subscription behind for the superseded wallet', async () => {
    const treasury = fakeWallet(944n);
    const consumer = fakeWallet(942n);

    let releaseTreasury!: (w: unknown) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((res) => { releaseTreasury = res; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));
    startWalletSync.mockImplementationOnce(async () => consumer.wallet);
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    releaseTreasury(treasury.wallet);
    await treasuryStart.catch(() => {});
    await consumerStart;
    await vi.waitFor(() => expect(treasury.wallet.stop).toHaveBeenCalled());

    const before = nights().length;
    treasury.push(); // a further update from the superseded engine
    expect(nights().length).toBe(before);
  });

  // The user-visible shape. A synced, idle wallet emits rarely (core audits
  // facade.state() at 1s and only on change), so whichever balance lands LAST
  // is what the panel keeps showing — for minutes, not milliseconds.
  it('leaves the active wallet balance as the last one the panel sees', async () => {
    const treasury = fakeWallet(944n);
    const consumer = fakeWallet(942n);

    let releaseTreasury!: (w: unknown) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((res) => { releaseTreasury = res; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));

    startWalletSync.mockImplementationOnce(async () => consumer.wallet);
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    releaseTreasury(treasury.wallet);
    await treasuryStart.catch(() => {});
    await consumerStart;
    await vi.waitFor(() => expect(treasury.wallet.stop).toHaveBeenCalled());

    const seen = nights();
    expect(seen.at(-1)).toBe('942');
  });

  // Separate defect on the same await. The rejection handler nulls `current`
  // without checking whose it is, so a superseded wallet that FAILS to start
  // tears down the session of the wallet the user actually switched to — every
  // later op then throws "No unlocked wallet is currently synced".
  it('does not tear down the active session when a superseded start fails', async () => {
    const consumer = fakeWallet(942n);

    let failTreasury!: (e: Error) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((_res, rej) => { failTreasury = rej; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));

    startWalletSync.mockImplementationOnce(async () => consumer.wallet);
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    failTreasury(new Error('indexer unreachable'));
    await treasuryStart.catch(() => {});
    await consumerStart;

    // `current` must still be consumer's. syncEnsure short-circuits on
    // `if (current?.key === key)`, so a repeat call starts no new engine — if
    // the failed start had nulled `current`, this would be a third start.
    await host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);
    expect(startWalletSync).toHaveBeenCalledTimes(2);
  });
});
