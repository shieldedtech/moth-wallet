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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

/** A controllable stand-in for core's SyncedWallet, matching the three
 *  behaviours that matter: subscribe() emits immediately, stop() kills the feed,
 *  and stop() does NOT clear the subscriber list.
 *
 *  That last one is load-bearing. Core's stop (sync/wallet-sync.ts) unsubscribes
 *  the Rx source and nothing else — `subscribers` survives for the lifetime of
 *  the document. A fake that empties the list on stop can never observe a leaked
 *  callback, which would make the leak assertion below vacuous. */
function fakeWallet(night: bigint) {
  const subscribers: Array<(b: unknown) => void> = [];
  let stopped = false;
  const balances = { unshielded: { night }, shielded: {}, dust: 0n, synced: true };
  return {
    wallet: {
      facade: {},
      balances,
      stop: vi.fn(async () => { stopped = true; }),
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
    /** Callbacks still registered with this engine — core leaves these in place
     *  across stop(), so anything left here outlives the wallet's turn. */
    subscriberCount: () => subscribers.length,
  };
}

// Pay the cold cost of the wallet-host module graph here, at collection time,
// where no hook timeout applies. `beforeEach` still re-imports it for a fresh
// module registry, but that re-import is ~0ms once the graph is warm — and a
// 10s `hookTimeout` is not a budget a cold graph load reliably fits on CI.
import '../lib/offscreen/wallet-host';

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

  afterEach(() => {
    vi.useRealTimers();
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

    // The superseded start's handle is stored nowhere, so syncStop cannot reach
    // it and core's stop() will not clear it. Unless syncEnsure calls it on the
    // spot, the callback stays in core's subscriber list for the lifetime of the
    // offscreen document.
    expect(treasury.subscriberCount()).toBe(0);
  });

  // The user-visible window, and the reason this is not a flicker.
  //
  // syncStop blocks on the superseded start, so the stale emission always lands
  // BEFORE the new wallet's own start is even issued. What the user then looks
  // at is the new wallet's start window — a cold start scans from the birthday —
  // and for the whole of it the panel is showing the previous wallet's balance
  // under the new wallet's name. Nothing corrects it until the new engine
  // produces its first emission.
  it('publishes nothing for the new wallet while its own start is still running', async () => {
    const treasury = fakeWallet(944n);
    const consumer = fakeWallet(942n);

    let releaseTreasury!: (w: unknown) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((res) => { releaseTreasury = res; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));

    // Consumer's own start is slow — this is the window that matters.
    let releaseConsumer!: (w: unknown) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((res) => { releaseConsumer = res; }));
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    releaseTreasury(treasury.wallet);
    await treasuryStart.catch(() => {});
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(2));

    // The user has switched and the new engine is still coming up. An empty
    // panel is correct here; the previous wallet's balance is not.
    expect(nights()).toEqual([]);

    releaseConsumer(consumer.wallet);
    await consumerStart;
    expect(nights()).toEqual(['942']);
  });

  // Separate defect on the same await. The rejection handler nulls `current`
  // without checking whose it is, so a superseded wallet that FAILS to start
  // tears down the session of the wallet the user actually switched to — every
  // later op then throws "No unlocked wallet is currently synced".
  //
  // Reaching it needs the rejection to land AFTER the switch has completed, and
  // syncStop normally blocks on the superseded start settling either way. The
  // one interleaving that gets past it is a start that hangs longer than
  // syncStop's own bound, STOP_TIMEOUT_MS: the wait is abandoned, the new wallet
  // becomes `current`, and only then does the old start fail. Hence fake timers.
  it('does not tear down the active session when a superseded start fails late', async () => {
    vi.useFakeTimers();
    const consumer = fakeWallet(942n);

    let failTreasury!: (e: Error) => void;
    startWalletSync.mockImplementationOnce(() => new Promise((_res, rej) => { failTreasury = rej; }));
    const treasuryStart = host.syncEnsure('aa'.repeat(32), 'treasury', NETWORK);
    void treasuryStart.catch(() => {}); // rejects much later; do not trip the unhandled-rejection guard
    await vi.waitFor(() => expect(startWalletSync).toHaveBeenCalledTimes(1));

    startWalletSync.mockImplementationOnce(async () => consumer.wallet);
    const consumerStart = host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);

    // Treasury's start never settles, so consumer is stuck in syncStop until the
    // STOP_TIMEOUT_MS bound gives up on it.
    await vi.advanceTimersByTimeAsync(30_000);
    await consumerStart;
    expect(startWalletSync).toHaveBeenCalledTimes(2);

    // Only now does the abandoned start fail — with consumer already `current`.
    failTreasury(new Error('indexer unreachable'));
    await treasuryStart.catch(() => {});

    // `current` must still be consumer's. syncEnsure short-circuits on
    // `if (current?.key === key)`, so a repeat call starts no new engine — if
    // the failed start had nulled `current`, this would be a third start.
    startWalletSync.mockImplementation(async () => fakeWallet(1n).wallet);
    await host.syncEnsure('bb'.repeat(32), 'consumer', NETWORK);
    expect(startWalletSync).toHaveBeenCalledTimes(2);
  });
});
