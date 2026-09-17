import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Browser } from 'wxt/browser';

// Drive sync-service's teardown logic against a mocked offscreen document. The
// deps it touches during teardown/scheduling are stubbed; the real module's
// port/op/epoch/timer state is what we exercise.
const exists = vi.fn<() => Promise<boolean>>();
const syncStop = vi.fn<() => Promise<void>>();
const close = vi.fn<() => Promise<void>>();
const syncEnsure = vi.fn<() => Promise<void>>();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    exists: () => exists(),
    syncStop: () => syncStop(),
    close: () => close(),
    syncEnsure: (...a: unknown[]) => syncEnsure(...(a as [])),
  },
}));

// registerSyncEvents subscribes through offscreenOn; capture the handlers so a
// test can emit a balances event at a chosen moment in the lifecycle.
const offscreenHandlers = new Map<string, (msg: { data: unknown }) => void>();
vi.mock('../lib/offscreen/messaging', () => ({
  offscreenOn: (event: string, fn: (msg: { data: unknown }) => void) => {
    offscreenHandlers.set(event, fn);
  },
}));

const hasPendingApproval = vi.fn<() => boolean>();
vi.mock('../lib/background/approvals', () => ({ hasPendingApproval: () => hasPendingApproval() }));

vi.mock('../lib/background/keepalive', () => ({ acquireKeepalive: vi.fn(), releaseKeepalive: vi.fn() }));

const TEARDOWN_DELAY_MS = 10_000;

function fakePort() {
  const listeners: Array<() => void> = [];
  const port = {
    postMessage: vi.fn(),
    onDisconnect: {
      addListener: (fn: () => void) => {
        listeners.push(fn);
      },
    },
    sender: undefined,
  } as unknown as Browser.runtime.Port;
  return { port, disconnect: () => listeners.forEach((fn) => fn()) };
}

describe('sync-service teardown', () => {
  // Fresh module state per test — sync-service keeps ports/opsInFlight/epoch/timer
  // in module scope, and there's no reset hook.
  let sync: typeof import('../lib/background/sync-service');

  beforeEach(async () => {
    vi.resetModules();
    exists.mockReset().mockResolvedValue(true);
    syncStop.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    syncEnsure.mockReset().mockResolvedValue(undefined);
    hasPendingApproval.mockReset().mockReturnValue(false);
    sync = await import('../lib/background/sync-service');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tears down after the debounce when idle: syncStop then close', async () => {
    vi.useFakeTimers();
    const { port, disconnect } = fakePort();
    sync.addPort(port);
    disconnect(); // last port gone → schedules the debounced teardown

    await vi.advanceTimersByTimeAsync(TEARDOWN_DELAY_MS);

    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('aborts the close when a port arrives during the (slow) syncStop', async () => {
    let releaseStop!: () => void;
    syncStop.mockImplementation(() => new Promise<void>((resolve) => (releaseStop = resolve)));

    const done = sync.teardown();
    await Promise.resolve(); // let teardown pass exists() and reach the syncStop await
    expect(syncStop).toHaveBeenCalledTimes(1);

    sync.addPort(fakePort().port); // activity returns mid-stop → bumps the epoch
    releaseStop();
    await done;

    expect(close).not.toHaveBeenCalled();
  });

  // The regression. A stop against an unreachable node never settled, and every
  // caller inherited the hang — the settings save, the idle teardown, the lock.
  it('closes a document that never answers the stop', async () => {
    vi.useFakeTimers();
    syncStop.mockImplementation(() => new Promise<void>(() => {}));

    const stopped = sync.stopSync();
    await vi.advanceTimersByTimeAsync(45_000);
    await stopped;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves the document alone when the engine answers the stop', async () => {
    await sync.stopSync();

    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a document that cannot be reached at all', async () => {
    syncStop.mockRejectedValue(new Error('Offscreen document did not become ready'));

    await sync.stopSync();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('force-closes even while a port is open (lock)', async () => {
    sync.addPort(fakePort().port); // not idle

    await sync.teardown({ force: true });

    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no document exists', async () => {
    exists.mockResolvedValue(false);

    await sync.teardown();

    expect(syncStop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('explicitly clears stale setup state when a panel reconnects', () => {
    const { port } = fakePort();

    sync.addPort(port);

    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'setupOpen', open: false });
  });

  it('reports a reattached setup tab to a connecting panel', () => {
    sync.addSetupPort(fakePort().port);
    const { port } = fakePort();

    sync.addPort(port);

    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'setupOpen', open: true });
  });

  it('notifies an open panel when cached balances are reset', async () => {
    const { port } = fakePort();
    sync.addPort(port);

    await sync.clearSnapshot();

    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'syncReset' });
  });

  // A fresh SW instance (the previous one was terminated) starts with an empty
  // ports set: reconcileStartup must close a leftover offscreen document unless
  // a surviving panel reconnects during the debounce.
  it('reconcileStartup tears down a leftover document when nothing reattaches', async () => {
    vi.useFakeTimers();
    sync.reconcileStartup();

    await vi.advanceTimersByTimeAsync(TEARDOWN_DELAY_MS);

    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reconcileStartup spares the document when a port reconnects within the debounce', async () => {
    vi.useFakeTimers();
    sync.reconcileStartup();
    sync.addPort(fakePort().port); // panel reconnects ~1s after the SW restart

    await vi.advanceTimersByTimeAsync(TEARDOWN_DELAY_MS);

    expect(syncStop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

// The cached snapshot is what lets a reopened panel render immediately instead
// of sitting on the interstitial while the SDK restores its caches (a
// multi-megabyte dust state). It must survive a restart of the same account and
// must not survive an account switch.
describe('sync-service snapshot reuse', () => {
  const SNAPSHOT = 'balances.snapshot';
  const OWNER = 'balances.snapshot.owner';
  const session = { seedHex: 'ab'.repeat(32), walletName: 'Account-2' } as never;
  const network = { id: 'preprod' } as never;

  let sync: typeof import('../lib/background/sync-service');
  let storage: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> };

  beforeEach(async () => {
    vi.resetModules();
    syncEnsure.mockReset().mockResolvedValue(undefined);
    exists.mockReset().mockResolvedValue(true);
    hasPendingApproval.mockReset().mockReturnValue(false);
    sync = await import('../lib/background/sync-service');
    const { browser } = await import('wxt/browser');
    storage = browser.storage.session as unknown as typeof storage;
    await storage.set({ [SNAPSHOT]: '{"dust":"1"}' });
  });

  it('keeps the snapshot when the same account restarts (idle teardown, SW recycle)', async () => {
    await storage.set({ [OWNER]: 'preprod/Account-2' });

    await sync.startSync(session, network);

    expect((await storage.get(SNAPSHOT))[SNAPSHOT]).toBe('{"dust":"1"}');
    expect(syncEnsure).toHaveBeenCalledTimes(1);
  });

  it('drops the snapshot when the account differs', async () => {
    await storage.set({ [OWNER]: 'preprod/Account-1' });

    await sync.startSync(session, network);

    expect((await storage.get(SNAPSHOT))[SNAPSHOT]).toBeUndefined();
  });

  it('drops an unattributable snapshot', async () => {
    // No owner recorded — e.g. written by a dApp-initiated sync that never went
    // through startSync. Not safe to show under a named account.
    await sync.startSync(session, network);

    expect((await storage.get(SNAPSHOT))[SNAPSHOT]).toBeUndefined();
  });
});

// The panel blanks to "Getting things ready" and reloads itself, with no user
// action and regardless of auto-lock. Reported against 0.10.11.
//
// The path: teardown() clears currentKey before the slow syncStop, and the
// engine keeps emitting balances for the seconds that stop takes. Those
// emissions used to be saved with an empty owner, so the NEXT startSync saw a
// mismatch, called clearSnapshot() and broadcast syncReset — which is what
// empties the panel.
describe('sync-service snapshot ownership during teardown', () => {
  const SNAPSHOT = 'balances.snapshot';
  const OWNER = 'balances.snapshot.owner';
  const session = { seedHex: 'ab'.repeat(32), walletName: 'Account-2' } as never;
  const network = { id: 'preprod' } as never;

  let sync: typeof import('../lib/background/sync-service');
  let storage: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> };

  beforeEach(async () => {
    vi.resetModules();
    offscreenHandlers.clear();
    syncEnsure.mockReset().mockResolvedValue(undefined);
    exists.mockReset().mockResolvedValue(true);
    syncStop.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    hasPendingApproval.mockReset().mockReturnValue(false);
    sync = await import('../lib/background/sync-service');
    const { browser } = await import('wxt/browser');
    storage = browser.storage.session as unknown as typeof storage;
    sync.registerSyncEvents();
  });

  const emitBalances = async (payload: string) => {
    offscreenHandlers.get('os/eventBalances')?.({ data: payload });
    await Promise.resolve();
    await Promise.resolve();
  };

  it('records the owner while an account is active', async () => {
    await sync.startSync(session, network);
    await emitBalances('{"dust":"1"}');
    expect((await storage.get(OWNER))[OWNER]).toBe('preprod/Account-2');
  });

  it('does not overwrite a good owner with balances arriving after teardown', async () => {
    await sync.startSync(session, network);
    await emitBalances('{"dust":"1"}');

    // teardown() nulls currentKey up front; the engine is still emitting.
    await sync.teardown({ force: true });
    await emitBalances('{"dust":"2"}');

    // The owner must still attribute the snapshot to the account that produced
    // it. An empty owner here is what blanks the panel on the next start.
    expect((await storage.get(OWNER))[OWNER]).toBe('preprod/Account-2');
  });

  it('so the same account restarting keeps its snapshot', async () => {
    await sync.startSync(session, network);
    await emitBalances('{"dust":"1"}');
    await sync.teardown({ force: true });
    await emitBalances('{"dust":"2"}');

    await sync.startSync(session, network);

    // Survived: no clearSnapshot(), so no syncReset, so the panel keeps
    // rendering instead of falling back to the loading screen.
    expect((await storage.get(SNAPSHOT))[SNAPSHOT]).toBe('{"dust":"1"}');
  });
});

// A transaction stage is state, not just an event: a WASM proof runs for
// minutes, and a panel opened (or a dApp approval closed) mid-way has to learn
// that the wallet is working, and since when. The background therefore keeps
// the live stage, replays it to each new port, and clears it when the op ends.
describe('sync-service transaction stage', () => {
  let sync: typeof import('../lib/background/sync-service');

  beforeEach(async () => {
    vi.resetModules();
    exists.mockReset().mockResolvedValue(true);
    syncStop.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    hasPendingApproval.mockReset().mockReturnValue(false);
    offscreenHandlers.clear();
    sync = await import('../lib/background/sync-service');
    sync.registerSyncEvents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const emitStage = (stage: string) => offscreenHandlers.get('os/eventTxStage')!({ data: stage });

  it('stamps each stage with when it began and broadcasts it', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { port } = fakePort();
    sync.addPort(port);

    emitStage('proving');

    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'txStage', stage: 'proving', since: 1_000 });
  });

  it('replays the stage in progress to a port that connects mid-op', () => {
    vi.useFakeTimers({ now: 5_000 });
    sync.beginOp();
    emitStage('proving');
    vi.setSystemTime(65_000);

    const { port } = fakePort();
    sync.addPort(port);

    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'txStage', stage: 'proving', since: 5_000 });
  });

  it('clears the stage for every port when the last op ends, and not before', () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    sync.addPort(port);
    sync.beginOp();
    sync.beginOp(); // a second, overlapping op (a dApp request during a send)
    emitStage('submitting');

    sync.endOp();
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'txStage', stage: null }));

    sync.endOp();
    expect(port.postMessage).toHaveBeenCalledWith({ kind: 'txStage', stage: null, since: null });

    // Nothing to replay any more.
    const { port: late } = fakePort();
    sync.addPort(late);
    expect(late.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'txStage' }));
  });

  it('does not broadcast a clear when no stage was ever reported', () => {
    vi.useFakeTimers();
    const { port } = fakePort();
    sync.addPort(port);

    sync.beginOp();
    sync.endOp();

    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'txStage' }));
  });
});

// syncInProgress feeds the auto-lock: a panel watching an engine that has not
// reported itself synced holds the lock; anything else does not.
describe('sync-service syncInProgress', () => {
  const session = { seedHex: 'ab'.repeat(32), walletName: 'Account-2' } as never;
  const network = { id: 'preprod' } as never;
  let sync: typeof import('../lib/background/sync-service');

  beforeEach(async () => {
    vi.resetModules();
    offscreenHandlers.clear();
    syncEnsure.mockReset().mockResolvedValue(undefined);
    exists.mockReset().mockResolvedValue(true);
    syncStop.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    hasPendingApproval.mockReset().mockReturnValue(false);
    sync = await import('../lib/background/sync-service');
    sync.registerSyncEvents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const emitBalances = (synced: boolean) =>
    offscreenHandlers.get('os/eventBalances')!({ data: JSON.stringify({ synced, coins: {} }) });

  it('is false with no panel, and false with a panel but no engine', async () => {
    expect(sync.syncInProgress()).toBe(false);
    sync.addPort(fakePort().port);
    expect(sync.syncInProgress()).toBe(false);
  });

  it('holds from sync start (no balances yet) until the engine reports synced', async () => {
    sync.addPort(fakePort().port);
    await sync.startSync(session, network);
    expect(sync.syncInProgress()).toBe(true); // restoring caches, nothing emitted

    emitBalances(false);
    expect(sync.syncInProgress()).toBe(true);

    emitBalances(true);
    expect(sync.syncInProgress()).toBe(false);
  });

  it('releases when the panel closes even mid-sync (the idle teardown takes over)', async () => {
    const { port, disconnect } = fakePort();
    sync.addPort(port);
    await sync.startSync(session, network);
    emitBalances(false);

    disconnect();

    expect(sync.syncInProgress()).toBe(false);
  });

  it("forgets the previous account's synced state when a new sync starts", async () => {
    vi.useFakeTimers();
    sync.addPort(fakePort().port);
    await sync.startSync(session, network);
    emitBalances(true);
    expect(sync.syncInProgress()).toBe(false);

    await sync.startSync({ seedHex: 'cd'.repeat(32), walletName: 'Account-3' } as never, network);

    expect(sync.syncInProgress()).toBe(true);
  });
});
