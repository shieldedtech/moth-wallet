// Service-worker side of sync: owns the UI ports, the balances snapshot
// (storage.session) and the keepalive, and relays sync updates from the
// offscreen document out to every open port. The sync engine itself (and its
// WASM) lives in the offscreen document — see lib/offscreen/wallet-host.ts.

import { browser, type Browser } from 'wxt/browser';
import type { NetworkConfig } from '@shieldedtech/moth-browser';
import { type PortEvent } from '../messaging/protocol';
import { offscreenOn, type RelayState } from '../offscreen/messaging';
import { offscreen } from './offscreen-client';
import { acquireKeepalive, releaseKeepalive } from './keepalive';
import { hasPendingApproval } from './approvals';
import { record as recordTiming } from './timings';
import type { Session } from './session';

const SNAPSHOT_KEY = 'balances.snapshot';
// Which `${networkId}/${walletName}` the stored snapshot belongs to. Persisted
// beside it (not just held in module state) so it survives a service-worker
// recycle, which is exactly when the snapshot matters most.
const SNAPSHOT_OWNER_KEY = 'balances.snapshot.owner';

type Port = Browser.runtime.Port;

const ports = new Set<Port>();
// Reset per sync start so each unlock/restart reports its own first emission.
let sawBalancesSinceStart = false;
// Last relay reachability seen, replayed to each newly-connected port. In-memory
// only: it describes a live socket, so a value surviving a SW restart would be a
// claim about a connection this process has never observed.
let lastRelayState: RelayState | null = null;
let currentKey: string | null = null;
// Operations (panel sends, dApp connector builds/submits) currently in flight.
let opsInFlight = 0;

// When the extension goes fully idle we don't just stop sync — we close the
// offscreen document too, so the worker + WASM heap exit with it and the SW
// suspends (~30s later). A short debounce absorbs port flaps (panel toggle,
// reload) without thrashing the worker/WASM init; resume from the IDB cache is
// cheap. See teardown().
const TEARDOWN_DELAY_MS = 10_000;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

// Bumped whenever activity (re)appears — a new port, setup tab, or op. teardown()
// snapshots it before the slow syncStop and bails out of the close if it changed,
// so activity returning mid-teardown never gets its document closed underneath it.
let lifecycleEpoch = 0;

function broadcast(event: PortEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

export async function getSnapshot(): Promise<string | null> {
  const stored = await (browser.storage.session as Browser.storage.StorageArea).get(SNAPSHOT_KEY);
  return (stored[SNAPSHOT_KEY] as string | undefined) ?? null;
}

async function saveSnapshot(payload: string): Promise<void> {
  // Never write a snapshot we cannot attribute. currentKey is null while a
  // teardown is in flight — it is cleared before the slow syncStop — and the
  // engine keeps emitting balances for the seconds that stop takes. Recording
  // those under an empty owner poisons the store: the next startSync sees an
  // owner mismatch, calls clearSnapshot(), and broadcasts syncReset, which
  // blanks an OPEN panel back to "Getting things ready" and then reloads it.
  // No user action is involved and auto-lock is irrelevant, so it reads as the
  // wallet spontaneously restarting itself.
  //
  // Skipping leaves the previous, attributable snapshot in place. That is the
  // same account's data and exactly what the panel should keep rendering — the
  // outcome the owner check exists to produce. A dApp op that drives sync
  // without startSync likewise contributes nothing rather than overwriting a
  // good snapshot with an unusable one.
  if (currentKey === null) return;
  await (browser.storage.session as Browser.storage.StorageArea).set({
    [SNAPSHOT_KEY]: payload,
    [SNAPSHOT_OWNER_KEY]: currentKey,
  });
}

async function getSnapshotOwner(): Promise<string> {
  const stored = await (browser.storage.session as Browser.storage.StorageArea).get(SNAPSHOT_OWNER_KEY);
  return (stored[SNAPSHOT_OWNER_KEY] as string | undefined) ?? '';
}

export async function clearSnapshot(): Promise<void> {
  await (browser.storage.session as Browser.storage.StorageArea).remove([SNAPSHOT_KEY, SNAPSHOT_OWNER_KEY]);
  broadcast({ kind: 'syncReset' });
}

/** Start (or resume) sync for the unlocked wallet in the offscreen document. */
export async function startSync(session: Session, network: NetworkConfig): Promise<void> {
  const key = `${network.id}/${session.walletName}`;
  if (currentKey === key) return;
  // Switching accounts/network: drop the previous account's cached snapshot
  // (and reset the panels) so its balances, coins and progress can't be shown
  // under the newly-selected account until the new sync emits its first update.
  //
  // Only when it really is a different account, though. currentKey is also null
  // after an idle teardown or a service-worker recycle, and clearing on those
  // made every cold open block on the interstitial until the SDK finished
  // restoring its caches — a multi-megabyte dust state, so tens of seconds. The
  // snapshot's own owner key distinguishes the two cases; a matching one is the
  // same account's data and is exactly what the panel should render immediately.
  if ((await getSnapshotOwner()) !== key) await clearSnapshot();
  sawBalancesSinceStart = false;
  currentKey = key;
  try {
    await offscreen.syncEnsure({ seedHex: session.seedHex, walletName: session.walletName, network });
  } catch (error) {
    // A failed ensure must remain retryable (panel reconnect, manual retry).
    if (currentKey === key) currentKey = null;
    throw error;
  }
}

/** Stop the current engine and make the same target eligible to start again. */
export async function stopSync(): Promise<void> {
  currentKey = null;
  if (await offscreen.exists()) await offscreen.syncStop();
}

export function beginOp(): void {
  lifecycleEpoch++;
  cancelTeardown();
  opsInFlight++;
  acquireKeepalive();
}

export function endOp(): void {
  opsInFlight = Math.max(0, opsInFlight - 1);
  releaseKeepalive();
  maybeScheduleTeardown();
}

export function addPort(port: Port): void {
  lifecycleEpoch++;
  cancelTeardown();
  ports.add(port);
  // Always send the current setup state. A reconnecting panel may still hold
  // `true` from the service-worker instance that just died, so silence is not
  // equivalent to false here.
  try {
    port.postMessage({ kind: 'setupOpen', open: setupPorts.size > 0 } satisfies PortEvent);
    // Replay the relay state for the same reason: a panel opened during an
    // outage must show it now, not after the next attempt.
    if (lastRelayState) port.postMessage({ kind: 'relayState', state: lastRelayState } satisfies PortEvent);
  } catch {
    /* port closed */
  }
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    maybeScheduleTeardown();
  });
}

// --- Setup-tab presence -----------------------------------------------------
// The setup tab holds a port open while an account is being created/imported;
// panels render a waiting screen while any such port exists.

const setupPorts = new Set<Port>();

export function addSetupPort(port: Port): void {
  lifecycleEpoch++;
  cancelTeardown();
  setupPorts.add(port);
  broadcast({ kind: 'setupOpen', open: true });
  port.onDisconnect.addListener(() => {
    setupPorts.delete(port);
    if (setupPorts.size === 0) {
      broadcast({ kind: 'setupOpen', open: false });
    }
    // A setup tab holds the wallet open too — its close joins the idle check.
    maybeScheduleTeardown();
  });
}

/** Tabs currently holding a setup port (for focusing or cancelling). */
export function getSetupTabIds(): number[] {
  return [...setupPorts]
    .map((port) => port.sender?.tab?.id)
    .filter((id): id is number => id !== undefined);
}

export function hasOpenPorts(): boolean {
  return ports.size > 0;
}

/** Whether a transaction op or a pending approval is running — the auto-lock
 *  must not lock (drop the seed) underneath one; it waits for the next tick. */
export function hasWorkInFlight(): boolean {
  return opsInFlight > 0 || hasPendingApproval();
}

/** Tell every open panel the session was locked out-of-band (auto-lock). */
export function broadcastSessionLocked(): void {
  broadcast({ kind: 'sessionLocked' });
}

export function broadcastTxStage(stage: PortEvent & { kind: 'txStage' }): void {
  broadcast(stage);
}

export function broadcastApproval(id: string | null): void {
  broadcast({ kind: 'approval', id });
}

// Fully idle: nothing watching, nothing in flight, no decision pending. An
// approval popup may hold no balances port, so it's checked explicitly — don't
// tear the wallet down under a pending dApp decision.
function idle(): boolean {
  return ports.size === 0 && setupPorts.size === 0 && opsInFlight === 0 && !hasPendingApproval();
}

function cancelTeardown(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

// Debounced idle teardown. Re-checks idle() when the timer fires (a port/op may
// have arrived during the delay).
function maybeScheduleTeardown(): void {
  if (!idle()) return;
  cancelTeardown();
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (idle()) void teardown();
  }, TEARDOWN_DELAY_MS);
}

// Full exit: stop the sync engine (awaits its final sync-state save to IDB),
// then close the offscreen document — the worker + WASM heap die with it, and
// with nothing left pinging the SW, Chrome suspends it.
//
// The stop MUST finish before the close, or we'd kill the process mid
// cache-write. syncStop is unconditional (not gated on currentKey): a dApp op
// can start a worker-side sync without ever going through startSync, and that
// sync still needs its final save. Because the stop takes seconds, we snapshot
// the lifecycle epoch first and — unless forced — abort the close if activity
// returned meanwhile (a reconnecting panel or a dApp op bumps the epoch),
// leaving its freshly (re)started sync alive in the open document instead of
// closing it underneath. lockNow passes { force: true }: locking must drop key
// material even with the panel open on the lock screen.
export async function teardown(opts?: { force?: boolean }): Promise<void> {
  const epoch = lifecycleEpoch;
  currentKey = null; // next startSync must re-ensure the (possibly recreated) doc
  if (!(await offscreen.exists())) return; // already gone — nothing to stop or close
  await offscreen.syncStop().catch(() => {});
  if (!opts?.force && (epoch !== lifecycleEpoch || !idle())) return;
  await offscreen.close();
}

// Called once at service-worker startup. Chrome may have terminated the
// previous SW instance while the offscreen document was still open (any >30s
// gap in event traffic does it); this instance then starts with an empty ports
// set that nothing ever prunes to zero — so without this check a wallet whose
// panel closed during the gap would keep syncing, seed in worker memory, with
// no window open. Scheduling the normal debounced teardown covers it: a
// surviving panel reconnects its port within ~1s (see usePanelEvents), which
// cancels the timer, and teardown() re-verifies idleness before closing.
export function reconcileStartup(): void {
  maybeScheduleTeardown();
}

/** Wire once from the background entrypoint: fan offscreen updates out to ports. */
export function registerSyncEvents(): void {
  offscreenOn('os/eventBalances', ({ data }) => {
    // First emission only: it is the moment the panel can finally render, so it
    // is the number the "why is unlock slow" question is actually about. Later
    // emissions arrive ~1s apart and would drown the timeline.
    if (!sawBalancesSinceStart) {
      sawBalancesSinceStart = true;
      void recordTiming('marker', 'first balances emission (panel can render)');
    }
    void saveSnapshot(data);
    broadcast({ kind: 'balances', data });
  });
  offscreenOn('os/eventSyncMessage', ({ data }) => {
    void recordTiming('sync', data);
    broadcast({ kind: 'syncMessage', message: data });
  });
  offscreenOn('os/eventTxStage', ({ data }) => {
    void recordTiming('tx', `tx: ${data}`);
    broadcast({ kind: 'txStage', stage: data });
  });
  offscreenOn('os/eventRelayState', ({ data }) => {
    // Cached like the balances snapshot: the panel mounts long after the relay
    // first failed, and a state that only arrives on change would leave it
    // blank until the next attempt an entire minute later.
    lastRelayState = data;
    broadcast({ kind: 'relayState', state: data });
  });
}
