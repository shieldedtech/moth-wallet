// Runs ONLY inside the offscreen document. This is the single place the wallet
// SDK + ledger WASM are touched: wallet CRUD, keystore unlock, the sync engine,
// and transaction building/submission. The service worker reaches everything
// here over the offscreen messaging channel.

import { relayRetry, setRelayUrl } from './relay-socket';
import { installBundledReference, hasBundledReference } from './bundled-preseed';
import { requestMeter, type MeterSnapshot } from './request-meter';
import {
  createMothBrowser,
  startWalletSync,
  buildTransferTransaction,
  estimateTransferFee as coreEstimateTransferFee,
  balanceTransaction as coreBalanceTransaction,
  buildSwapIntent,
  designateForDust as coreDesignateForDust,
  dedesignateFromDust as coreDedesignateFromDust,
  submitFinalizedTransaction,
  deriveShieldedPublicKeys,
  deriveWalletKeys,
  clearSyncCache,
  clearDustSyncCache,
  clearShieldedSyncCache,
  markShieldedSpent,
  shieldedNullifiersOf,
  warmEmptyRefCache,
  preseedReferenceStatus,
  DustRegistrationNotYetError,
  type WarmProgress,
  signMessage,
  deriveAppSecret as coreDeriveAppSecret,
  deriveActivity,
  IdbSyncStateStore,
  createProvingProvider,
  ensureProverReady,
  resolveProverConfig,
  EMPTY_COINS,
  type SyncedWallet,
  type NetworkConfig,
  type WalletBalances,
  type WalletKeys,
  type SendRequest,
  type SwapInput,
  type SignEncoding,
  type SignedMessage,
} from '@shieldedtech/moth-browser';
import { deriveAllAddressesFromSeed } from '@shieldedtech/moth-wallet/wallet/address';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { HistoryEntry } from '@midnight-ntwrk/dapp-connector-api';
import { serializeBalances } from '../messaging/balances-json';
import { serializeActivity } from '../messaging/activity-json';
import { waitForSyncedBalances } from './wait-synced';
import { dustHealKey } from './dust-heal';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { NightCoinRow } from '../messaging/protocol';
import {
  loadSubmissions,
  mergeSubmissions,
  recordSubmission,
  saveSubmissions,
  submissionsKey,
  type SubmittedTx,
} from './submissions';
import type {
  TransferRequestDTO,
  SwapInputDTO,
  UnlockedWallet,
  ProvingKeyMaterialDTO,
} from './messaging';
import type { DustNotYet } from '../messaging/protocol';
import type { HostEvent, HostEventData } from './worker-rpc';

const SYNC_WAIT_MS = 60_000;

// Events (balances / sync progress / tx stage) reach the SW through an injected
// emitter: the production worker entry wires it to postMessage; the dev inline
// fallback wires it to the offscreen messaging channel. Defaults to a no-op so a
// stray emission before wiring can't throw.
export type HostEmit = <E extends HostEvent>(event: E, data: HostEventData[E]) => void;
let emit: HostEmit = () => {};
export function setHostEmit(fn: HostEmit): void {
  emit = fn;
}

// In the dedicated worker (no `document`) sync runs at the SDK's full-throughput
// defaults (500/500/50 — see wallet-sync.ts). Only the dev inline fallback runs
// on the offscreen main thread, shared with the panel's renderer, where every
// synchronous WASM batch-apply blocks rendering; there we keep small, spaced
// batches so each apply stays short and the UI stays responsive.
const ON_MAIN_THREAD = typeof document !== 'undefined';
const MAIN_THREAD_BATCH = { size: 50, timeout: 100, spacing: 20 };

// The panel and dApp connector only read aggregate balances (shielded/unshielded/
// dust totals + sync progress), never the per-coin breakdown. `coins` — the dust
// coin list especially — grows throughout sync, so serializing, structured-
// cloning and JSON-parsing it on every ~1s emission (offscreen → SW → panel) is
// pure overhead that hitches the panel's main thread. Drop it at the boundary;
// the wallet's own state (with coins) stays intact inside the offscreen document.
function serializeForClients(balances: WalletBalances): string {
  return serializeBalances({ ...balances, coins: EMPTY_COINS });
}

// --- WalletManager, cached per network ------------------------------------

type Moth = ReturnType<typeof createMothBrowser>;
let cachedMoth: { network: string; moth: Moth } | null = null;

function getMoth(network: string): Moth {
  if (cachedMoth?.network !== network) {
    cachedMoth = { network, moth: createMothBrowser({ network }) };
  }
  return cachedMoth.moth;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toRequests(dtos: TransferRequestDTO[]): SendRequest[] {
  return dtos.map((d) => ({ type: d.type, tokenId: d.tokenId, amount: BigInt(d.amount), to: d.to }));
}

function toSwapInputs(dtos: SwapInputDTO[]): SwapInput[] {
  return dtos.map((d) => ({ type: d.type, tokenId: d.tokenId, amount: BigInt(d.amount) }));
}

// Server proving gets an actionable preflight error before expensive build
// work. Local WASM proving has no remote service to check.
async function ensureProver(network: NetworkConfig): Promise<void> {
  await ensureProverReady(resolveProverConfig(network));
}

// --- Wallet CRUD ----------------------------------------------------------

export async function walletList(network: string): Promise<ReturnType<Moth['wallets']['list']>> {
  return getMoth(network).wallets.list();
}

// The setup UI generates and shows the phrase (pure JS, no WASM) before asking
// for a password, then hands it back here so the stored wallet matches it.
export async function walletCreate(
  name: string,
  passphrase: string,
  network: string,
  birthday?: number,
  mnemonic?: string,
) {
  const { mnemonic: phrase, ...info } = await getMoth(network).wallets.generate(
    name,
    passphrase,
    network,
    birthday,
    mnemonic,
  );
  return { info, mnemonic: phrase };
}

export async function walletImport(name: string, mnemonic: string, passphrase: string, network: string) {
  return getMoth(network).wallets.import(name, mnemonic, passphrase, network);
}

export async function walletRemove(name: string, network: string): Promise<void> {
  await getMoth(network).wallets.remove(name);
}

export async function walletSetActive(name: string, network: string): Promise<void> {
  await getMoth(network).wallets.setActive(name);
}

export async function walletSetLabel(name: string, label: string, network: string): Promise<void> {
  await getMoth(network).wallets.setLabel(name, label);
}

// Reveal-phrase (Accounts screen): the original mnemonic, or the raw hex seed
// for wallets imported from hex. Passphrase-gated by the keystore decrypt —
// this never touches the unlocked session's key material.
export async function walletExportPhrase(
  name: string,
  passphrase: string,
  network: string,
): Promise<{ kind: 'mnemonic' | 'seed'; value: string }> {
  return getMoth(network).wallets.exportPhrase(name, passphrase);
}

export async function walletSetNetwork(
  name: string,
  fromNetwork: string,
  network: string,
  seedHex: string,
  birthday?: number,
): Promise<{ address: string; addresses: UnlockedWallet['addresses'] }> {
  // Derive first so invalid input cannot leave the wallet half-moved.
  const addresses = deriveAllAddressesFromSeed(seedHex);
  const address = addresses.nightExternal.bech32m[network];
  if (!address) throw new Error(`Cannot derive an address for network "${network}"`);

  // Sync state is NOT cleared on either side. It is keyed per network
  // (sync/<networkId>/<wallet>/<part>.dat), so both networks' caches coexist and
  // a return trip resumes from the last known good state instead of rescanning —
  // the same thing every ordinary restart does. This used to wipe both sides on
  // the grounds that "switching back must also perform a fresh scan rather than
  // revive state the user explicitly reset", which conflated switching networks
  // with resetting sync state; resetting is its own deliberate action on the
  // DUST screen. The cost of the wipe grew with dust: a return trip meant the
  // full chain walk, 78.6 min on preprod.
  //
  // `birthday` is the current tip of the network being moved TO. setNetwork
  // records it only on first arrival and only for wallets created here — an
  // imported wallet could hold funds on that chain at any height, so it keeps
  // scanning from genesis.
  await getMoth(fromNetwork).wallets.setNetwork(name, network, address, birthday);
  return { address, addresses };
}

export async function walletUnlock(name: string, passphrase: string, network: string): Promise<UnlockedWallet> {
  const unlocked = await getMoth(network).wallets.unlock(name, passphrase);
  try {
    // The offscreen is the key-holder. Core's unlock() is seed-free (Option A),
    // so recover the serializable seed explicitly: Chrome tears the offscreen
    // down at will, and the background must be able to re-supply this seed to
    // rebuild the WASM key bundle on each restart (walletKeys can't cross the
    // runtime-message boundary). The seed is dropped again after each op derives
    // its keys. See core WalletManager.exportSeedHex / D-KM-3.
    const seedHex = await getMoth(network).wallets.exportSeedHex(name, passphrase);
    const shielded = deriveShieldedPublicKeys(seedHex);
    return {
      name: unlocked.name,
      label: unlocked.label,
      network: unlocked.network,
      seedHex,
      address: unlocked.address,
      addresses: unlocked.addresses,
      shieldedCoinPublicKey: shielded.coinPublicKey,
      shieldedEncryptionPublicKey: shielded.encryptionPublicKey,
    };
  } finally {
    unlocked.lock();
  }
}

// --- Sync engine (singleton) ----------------------------------------------

let current: {
  key: string;
  synced: Promise<SyncedWallet>;
  // The WASM key bundle for this sync session, derived once from the seed the
  // background threads in (Option A: core is called only with keys). Reused by
  // every op so none re-derives or holds the raw seed past derivation.
  walletKeys: WalletKeys;
  unsubscribe?: () => void;
} | null = null;

/** Keys for the live sync session. Ops call this after syncEnsure so they pass
 *  walletKeys — never the seed — into the keys-based core write paths. */
function activeWalletKeys(): WalletKeys {
  if (!current?.walletKeys) throw new Error('No unlocked wallet is currently synced');
  return current.walletKeys;
}

// In-flight teardown. The background service worker fires syncStop without
// awaiting it (locking must not wait for the WASM state serialization), so a
// following syncEnsure must queue behind the shutdown instead of racing a new
// sync engine against it.
let stopping: Promise<void> | null = null;

/** Bound on waiting out a start-then-stop round trip. Well above a slow cold start,
 *  because abandoning a healthy one leaves two engines coming up at once. */
const STOP_TIMEOUT_MS = 30_000;

export async function syncEnsure(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<SyncedWallet> {
  const key = `${network.id}/${walletName}`;
  if (current?.key === key) return current.synced;

  await syncStop();

  // Name the socket the backoff wrapper should throttle. Must mirror how core
  // derives the SDK's relayURL from nodeUrl (sync/wallet-sync.ts), or the
  // wrapper won't recognise the connection and will pass it straight through.
  setRelayUrl(network.nodeUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'));

  // Put the packaged reference in place before startWalletSync looks for one.
  // Only writes when the store has none, so a locally built reference — always
  // at least as fresh — is never overwritten. A network without a bundled
  // reference is a no-op and syncs the slow way.
  await installBundledReference(network.id, new IdbSyncStateStore());

  // Wallets created by the extension store the chain tip at creation time as
  // their birthday; it lets the first sync pre-seed at tip instead of
  // scanning from genesis. Imported wallets have none and scan everything.
  const birthday = (await getMoth(network.id).wallets.list())
    .find((wallet) => wallet.name === walletName)?.birthday;

  // Derive the key bundle once for this session (Option A derive-and-drop):
  // startWalletSync and every subsequent op take walletKeys, and the raw seed
  // is not retained beyond this call.
  const walletKeys = deriveWalletKeys(seedHex);
  const synced = startWalletSync(
    walletKeys,
    network,
    (message) => emit('os/eventSyncMessage', message),
    walletName,
    false,
    birthday,
    { syncStore: new IdbSyncStateStore(), ...(ON_MAIN_THREAD ? { batchUpdates: MAIN_THREAD_BATCH } : {}) },
  );
  current = { key, synced, walletKeys };

  const wallet = await synced.catch((err) => {
    current = null;
    throw err;
  });

  const unsubscribe = wallet.subscribe((balances) => {
    emit('os/eventBalances', serializeForClients(balances));
  });
  if (current?.key === key) current.unsubscribe = unsubscribe;
  return wallet;
}

// Rebuild of a stale local dust view (registered NIGHT past the grace period
// with no generation records — see dust-heal.ts). Transaction-free: stop the
// engine, evict ONLY the dust cache, and restart; the dust sub-wallet rescans
// while the shielded/unshielded caches stay warm.
//
// This used to run automatically, on every balance emission whose dustGeneration
// showed a capacity deficit. That condition is reachable in normal operation —
// generation records take up to the ledger's 3h grace period to appear, a coin
// needs 7 days to reach its cap, and partially-registered NIGHT presents the
// same shape indefinitely — so it silently evicted a multi-megabyte cache and
// re-traversed the whole index space (10-15 minutes of visible resync) without
// resolving the condition. It is now user-initiated from the DUST screen, where
// the deficit is already displayed; shouldRepairDustView only decides whether to
// offer it (see dustView().canRebuild).
let dustRebuildInFlight = false;
let shieldedRebuildInFlight = false;

// Transaction work in flight (building/proving/balancing/submitting). The
// rebuild restarts the sync engine, which must NEVER happen underneath one of
// these — a dApp approval's fee balancing can be mid-proof.
let inFlightOps = 0;

async function trackOp<T>(run: () => Promise<T>): Promise<T> {
  inFlightOps += 1;
  try {
    return await run();
  } finally {
    inFlightOps -= 1;
  }
}

// Build the pre-seed reference for a network to chain tip, so accounts created
// afterwards start there instead of walking the chain (measured on preprod: 78.6
// min of dust sync becomes ~49s). The build IS that walk, paid once per network
// rather than once per account, and it needs no wallet keys of its own — the
// reference is an unfunded throwaway wallet.
//
// Deliberately fire-and-forget and interruptible. It runs for tens of minutes,
// far longer than a panel session, and the offscreen document is torn down when
// the extension goes idle. A killed build persists its progress, so the next
// attempt resumes rather than restarting; the reference only becomes usable once
// it actually reaches tip.
let refWarmInFlight: string | null = null;
// Last progress seen from an in-flight build, so the UI can poll it. An hour-long
// job reported as a bare "in progress" is indistinguishable from a stuck one.
let lastWarmProgress: WarmProgress | null = null;

/** Whether this network's reference is ready, and how far a build has got. */
export async function preseedStatus(
  network: NetworkConfig,
): Promise<{
  ready: boolean;
  height: number | null;
  bundled: boolean;
  building: boolean;
  applied: number;
  total: number;
}> {
  const status = await preseedReferenceStatus(network, new IdbSyncStateStore());
  return {
    ...status,
    bundled: await hasBundledReference(network.id),
    building: refWarmInFlight === network.id,
    applied: lastWarmProgress?.applied ?? 0,
    total: lastWarmProgress?.total ?? 0,
  };
}

// Re-exported so the SW can reach it over the normal host-dispatch path. The
// backoff state itself lives in the worker (installed before this module is
// imported), and both are the same module instance inside the worker bundle.
export { relayRetry };

/** Request counts for this context — see offscreen/request-meter.ts. Read-only
 *  and cheap: it prunes a bounded array and returns totals. */
export function requestStats(): MeterSnapshot {
  return requestMeter.snapshot();
}

/** Zero the counters. The lifetime figures are kept precisely so nothing else
 *  drops them, so clearing has to be something the user asks for. */
export function resetRequestStats(): void {
  requestMeter.reset();
}


export async function preseedWarm(network: NetworkConfig): Promise<{ started: boolean }> {
  if (refWarmInFlight === network.id) return { started: false };
  refWarmInFlight = network.id;
  try {
    const states = await warmEmptyRefCache(
      network,
      (message) => emit('os/eventSyncMessage', message),
      new IdbSyncStateStore(),
      (progress) => {
        lastWarmProgress = progress;
      },
    );
    return { started: states !== null };
  } catch {
    return { started: false };
  } finally {
    refWarmInFlight = null;
  }
}

/** Evict ONLY the shielded cache and restart sync so the shielded sub-wallet
 *  rescans. Deliberately separate from dustRebuild and from a full cache clear:
 *  DUST is the slowest sub-wallet to resync, so rebuilding shielded coin state
 *  must not force a DUST rescan.
 *
 *  `started: false` means a transaction was in flight and nothing was touched. */
export async function shieldedRebuild(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<{ started: boolean }> {
  if (shieldedRebuildInFlight || inFlightOps > 0) return { started: false };
  shieldedRebuildInFlight = true;
  try {
    emit('os/eventSyncMessage', 'Rebuilding shielded coin records…');
    await syncStop();
    await clearShieldedSyncCache(walletName, network.id, new IdbSyncStateStore());
    await syncEnsure(seedHex, walletName, network);
    return { started: true };
  } finally {
    shieldedRebuildInFlight = false;
  }
}

/** Evict the dust cache and restart sync so the dust sub-wallet rescans.
 *  `started: false` means a transaction was in flight and nothing was touched. */
export async function dustRebuild(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<{ started: boolean }> {
  if (dustRebuildInFlight || inFlightOps > 0) return { started: false };
  dustRebuildInFlight = true;
  try {
    const store = new IdbSyncStateStore();
    // Stamped for support/debugging — no longer gates anything, since the user
    // asked for this one explicitly.
    await store.put(dustHealKey(network.id, walletName), String(Date.now())).catch(() => {});
    emit('os/eventSyncMessage', 'Rebuilding DUST records…');
    await syncStop();
    await clearDustSyncCache(walletName, network.id, new IdbSyncStateStore());
    await syncEnsure(seedHex, walletName, network);
    return { started: true };
  } finally {
    dustRebuildInFlight = false;
  }
}

export async function syncStop(): Promise<void> {
  if (current) {
    const target = current;
    current = null;
    stopping = (stopping ?? Promise.resolve()).then(async () => {
      try {
        target.unsubscribe?.();
      } catch {
        /* subscription already gone */
      }
      // Unbounded on purpose: an engine that comes up after the wait below gave up
      // must still be stopped, or it keeps writing the cache the next one restores.
      const settled = target.synced.then(
        (wallet) => wallet.stop().catch(() => {}),
        () => {
          /* never finished starting */
        },
      );
      // The wait itself is bounded, because a start against an unreachable node
      // settles neither way and every caller of syncStop inherits that.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
        void settled.then(() => resolve(false));
      });
      clearTimeout(timer);
      if (timedOut) {
        emit(
          'os/eventSyncMessage',
          `Sync stop still pending after ${STOP_TIMEOUT_MS / 1000}s — continuing without it`,
        );
      }
    });
  }
  const inFlight = stopping;
  if (!inFlight) return;
  await inFlight;
  if (stopping === inFlight) stopping = null;
}

export async function syncCacheClear(walletName: string, networkIds: string[]): Promise<void> {
  // syncStop writes its final state, so it must finish before deletion. Best-effort:
  // an abandoned start can still come up later and write its cache back over this.
  await syncStop();
  const store = new IdbSyncStateStore();
  for (const networkId of new Set(networkIds)) {
    await clearSyncCache(walletName, networkId, store);
    // Local submission notes follow the sync state's lifecycle: a reset must
    // not revive pending rows for a chain state the user explicitly cleared.
    await store.delete(submissionsKey(networkId, walletName)).catch(() => {});
  }
}

export async function balancesGet(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<string> {
  const wallet = await syncEnsure(seedHex, walletName, network);
  return serializeForClients(await waitForSyncedBalances(wallet, SYNC_WAIT_MS));
}

/**
 * Shielded coins with the detail needed to SPEND one — nonce, colour, value and
 * Merkle index, i.e. a QualifiedShieldedCoinInfo.
 *
 * Separate from `balancesGet` on purpose. That path runs `serializeForClients`,
 * which deliberately blanks `coins` because the dust list grows all through sync
 * and shipping it on every ~1s emission hitches the panel's main thread. This is
 * ON DEMAND and SHIELDED-ONLY: a bounded list, requested only when a DApp
 * actually needs to spend a coin, so the emission path keeps its optimisation.
 *
 * Returns JSON with bigints as decimal strings — the offscreen→SW→page hops
 * cannot be relied on to preserve BigInt.
 */
export async function shieldedCoinsGet(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<string> {
  const wallet = await syncEnsure(seedHex, walletName, network);
  const balances = await waitForSyncedBalances(wallet, SYNC_WAIT_MS);
  const shielded = balances.coins.shielded;
  // Report sync state alongside the coins. An empty list is otherwise ambiguous
  // between "still syncing" and "genuinely none", and a caller cannot tell
  // whether to wait or to give up — the same total-0 ambiguity that makes sync
  // progress misreport.
  const shieldedSynced = balances.syncProgress.shieldedSynced;
  const rows = [
    ...shielded.available.map((c) => ({
      nonce: c.nonce ?? null,
      type: c.type,
      value: c.value.toString(),
      // Named mt_index to match the QualifiedShieldedCoinInfo a circuit wants.
      mt_index: c.mtIndex?.toString() ?? null,
      commitment: c.commitment ?? null,
      status: 'available' as const,
    })),
    ...shielded.pending.map((c) => ({
      nonce: c.nonce ?? null,
      type: c.type,
      value: c.value.toString(),
      // Not in the commitment tree yet, so not spendable.
      mt_index: null,
      commitment: c.commitment ?? null,
      status: 'pending' as const,
    })),
  ];
  return JSON.stringify({ shieldedSynced, coins: rows });
}

/**
 * Per-coin NIGHT breakdown: what is registered, and what is booked.
 *
 * The displayed NIGHT balance folds booked coins in, so "500 NIGHT" and "NIGHT
 * you can register" are different numbers and a wallet can read 500 while having
 * nothing to register. Without this, telling those apart meant opening the TUI.
 *
 * Values only — no UTXO ids, addresses or nonces. Enough to explain the balance,
 * not enough to identify a coin on chain.
 */
export async function nightCoins(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<NightCoinRow[]> {
  const wallet = await syncEnsure(seedHex, walletName, network);
  const balances = await waitForSyncedBalances(wallet, SYNC_WAIT_MS);
  const rows: NightCoinRow[] = [];
  const push = (list: readonly { value: bigint; type: string; registeredForDustGeneration?: boolean }[], booked: boolean) => {
    for (const c of list) {
      if (c.type !== NIGHT_TOKEN_ID) continue;
      rows.push({ valueStars: c.value.toString(), registered: c.registeredForDustGeneration === true, booked });
    }
  };
  push(balances.coins.unshielded.available, false);
  // "Pending" for an unshielded coin means booked: reserved as an input by a
  // transaction that has not settled. That is the state that makes registration
  // report nothing to do while the balance still shows the NIGHT.
  push(balances.coins.unshielded.pending, true);
  return rows;
}

// --- Transactions ---------------------------------------------------------

// Transfer construction books wallet inputs, even for a fee-only estimate.
// Keep estimates and submissions on one lane so multiple panels (or a rapid
// edit followed by Send) can never compete for the same facade state.
let transferOperationQueue: Promise<unknown> = Promise.resolve();

function enqueueTransferOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = transferOperationQueue.then(operation);
  transferOperationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Best effort: a bookkeeping failure must never turn a submitted transaction
// into a reported error — the tokens are already on their way.
async function noteSubmitted(networkId: string, walletName: string, tx: SubmittedTx): Promise<void> {
  try {
    await recordSubmission(new IdbSyncStateStore(), networkId, walletName, tx);
  } catch {
    /* ignore */
  }
}

export function sendTokens(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  requests: TransferRequestDTO[],
): Promise<{ txHash: string }> {
  return enqueueTransferOperation(() => trackOp(async () => {
    await ensureProver(network);
    const wallet = await syncEnsure(seedHex, walletName, network);
    const finalized = await buildTransferTransaction(
      wallet.facade,
      activeWalletKeys(),
      network.id,
      toRequests(requests),
      (stage) => emit('os/eventTxStage', stage),
    );
    emit('os/eventTxStage', 'submitting');
    const txHash = await submitFinalizedTransaction(wallet.facade, finalized);
    // The activity feed's pending row is single-output. Record the rich detail
    // only for a lone output; a batch records a plain pending send (the applied
    // chain entry supplies every delta once it lands).
    const single = requests.length === 1 ? requests[0] : undefined;
    await noteSubmitted(network.id, walletName, {
      hash: txHash,
      transactionHash: finalized.transactionHash(),
      submittedAt: Date.now(),
      kind: 'send',
      to: single?.to,
      tokenType: single?.tokenId,
      tokenKind: single?.type,
      amount: single?.amount,
      outputs: requests.length,
    });
    return { txHash };
  }));
}

export function estimateTransferFee(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  requests: TransferRequestDTO[],
): Promise<{ fee: string }> {
  return enqueueTransferOperation(() => trackOp(async () => {
    const wallet = await syncEnsure(seedHex, walletName, network);
    const fee = await coreEstimateTransferFee(
      wallet.facade,
      activeWalletKeys(),
      network.id,
      toRequests(requests),
    );
    return { fee: fee.toString() };
  }));
}

// Register the wallet's unshielded NIGHT for DUST generation. The core op
// auto-selects every currently-unregistered NIGHT UTXO. Finalizing proves the
// recipe, so preflight the proof server like the transfer path. Returns a null
// txHash when there was nothing left to register (all NIGHT already registered).
// `dustAddress` directs the generated DUST to another wallet's DUST address;
// omitted, it goes to this wallet's own (the core throws on an invalid one).
export async function registerDust(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  dustAddress?: string,
): Promise<{ txHash: string | null; notYet?: DustNotYet }> {
  return trackOp(async () => {
    await ensureProver(network);
    const wallet = await syncEnsure(seedHex, walletName, network);
    let txHash: string | null;
    try {
      txHash = await coreDesignateForDust(
        wallet.facade,
        seedHex,
        network.id,
        dustAddress,
        (stage) => emit('os/eventTxStage', stage),
      );
    } catch (e) {
      // Returned rather than rethrown: the panel needs the figures to render a
      // localized wait, and an Error crossing this channel arrives as a bare
      // string. Everything else still throws and surfaces as a failure.
      if (e instanceof DustRegistrationNotYetError) {
        return {
          txHash: null,
          notYet: {
            feeSpecks: e.estimate.fee.toString(),
            availableSpecks: e.estimate.available.toString(),
            secondsUntilAffordable: e.estimate.secondsUntilAffordable,
          },
        };
      }
      throw e;
    }
    if (txHash) {
      await noteSubmitted(network.id, walletName, { hash: txHash, submittedAt: Date.now(), kind: 'dust' });
    }
    return { txHash };
  });
}

// Deregister every registered NIGHT UTXO from DUST generation. The transaction
// is balanced and proven (fees are paid from existing DUST), so preflight the
// proof server too. The core throws when nothing is registered.
export async function deregisterDust(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<{ txHash: string }> {
  return trackOp(async () => {
    await ensureProver(network);
    const wallet = await syncEnsure(seedHex, walletName, network);
    const txHash = await coreDedesignateFromDust(
      wallet.facade,
      seedHex,
      network.id,
      (stage) => emit('os/eventTxStage', stage),
    );
    await noteSubmitted(network.id, walletName, { hash: txHash, submittedAt: Date.now(), kind: 'dust' });
    return { txHash };
  });
}

export async function transferBuild(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  requests: TransferRequestDTO[],
): Promise<{ txHex: string }> {
  return trackOp(async () => {
    await ensureProver(network);
    const wallet = await syncEnsure(seedHex, walletName, network);
    const finalized = await buildTransferTransaction(
      wallet.facade,
      activeWalletKeys(),
      network.id,
      toRequests(requests),
      (stage) => emit('os/eventTxStage', stage),
    );
    return { txHex: toHex(finalized.serialize()) };
  });
}

// Balance a dApp-supplied transaction (connector balance*Transaction). Needs a
// synced wallet (to source balancing inputs) and the proof server (the balancing
// segment is proven), so it preflights both like the transfer path.
export async function balanceTransaction(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  txHex: string,
  sealed: boolean,
): Promise<{ txHex: string }> {
  return trackOp(async () => {
    await ensureProver(network);
    const wallet = await syncEnsure(seedHex, walletName, network);
    const finalized = await coreBalanceTransaction(
      wallet.facade,
      activeWalletKeys(),
      network.id,
      fromHex(txHex),
      sealed,
      (stage) => emit('os/eventTxStage', stage),
    );
    return { txHex: toHex(finalized.serialize()) };
  });
}

// Build a swap intent (connector makeIntent). Needs a synced wallet to source
// the offered inputs; the result is unproven, so no proof server is required.
export async function makeIntent(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  inputs: SwapInputDTO[],
  outputs: TransferRequestDTO[],
  payFees: boolean,
): Promise<{ txHex: string }> {
  return trackOp(async () => {
    const wallet = await syncEnsure(seedHex, walletName, network);
    const intent = await buildSwapIntent(
      wallet.facade,
      activeWalletKeys(),
      network.id,
      toSwapInputs(inputs),
      toRequests(outputs),
      payFees,
      (stage) => emit('os/eventTxStage', stage),
    );
    return { txHex: toHex(intent.serialize()) };
  });
}

export async function transferSubmit(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  txHex: string,
): Promise<void> {
  return trackOp(async () => {
    const wallet = await syncEnsure(seedHex, walletName, network);
    const transaction = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>(
      'signature',
      'proof',
      'binding',
      fromHex(txHex),
    );
    await submitFinalizedTransaction(wallet.facade, transaction);
    // Record the shielded coins this transaction spends, so they stop being
    // reported as available before sync notices. Without this the wallet keeps
    // offering a spent coin and the next spend fails with "Insufficient funds",
    // which names the wrong cause. See core's spent-shielded.ts.
    markShieldedSpent(shieldedNullifiersOf(transaction));
  });
}

// --- Transaction history ---------------------------------------------------

// The wallet's applied history is on-chain, so we report it as `finalized`. The
// SDK gives one coarse status per entry, not per-segment data, so we surface it
// as the transaction's guaranteed section (segment 0). Moth only ever creates
// single-section transfers, so SUCCESS/FAILURE is exact for those;
// PARTIAL_SUCCESS (only reachable via external contract calls with fallible
// sections) reports the guaranteed section as applied. Pending (submitted but
// unconfirmed) transactions are not included yet.
function toHistoryEntry(entry: { hash: string; status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' }): HistoryEntry {
  return {
    txHash: entry.hash,
    txStatus: { status: 'finalized', executionStatus: { 0: entry.status === 'FAILURE' ? 'Failure' : 'Success' } },
  };
}

// Signing needs only the seed + network id (no sync engine), so this is
// deliberately independent of syncEnsure.
export function signData(
  seedHex: string,
  network: NetworkConfig,
  data: string,
  encoding: SignEncoding,
): SignedMessage {
  return signMessage(seedHex, network.id, data, encoding);
}

// Deterministic per-(origin, domain) app secret. Like signData, this needs
// only the seed (no sync engine). `origin` is passed in by the background from
// the connection session — never from DApp params — so a site can only derive
// secrets under its own origin. See specs/003-derive-app-secret.
export async function deriveAppSecret(
  seedHex: string,
  origin: string,
  domain: string,
): Promise<{ secret: string }> {
  return { secret: await coreDeriveAppSecret(seedHex, origin, domain) };
}

function connectorKeyMaterialProvider(keyLocation: string, material: ProvingKeyMaterialDTO) {
  const read = async (requested: string, value: Uint8Array): Promise<Uint8Array> => {
    if (requested !== keyLocation) {
      throw new Error(`Missing key material for circuit "${requested}"`);
    }
    return value;
  };
  return {
    getZKIR: (requested: string) => read(requested, material.zkir),
    getProverKey: (requested: string) => read(requested, material.proverKey),
    getVerifierKey: (requested: string) => read(requested, material.verifierKey),
  };
}

/** Execute the low-level provider returned by connector getProvingProvider. */
export async function provingProviderCheck(
  network: NetworkConfig,
  serializedPreimage: Uint8Array,
  keyLocation: string,
  keyMaterial: ProvingKeyMaterialDTO,
): Promise<(bigint | undefined)[]> {
  const provider = createProvingProvider(
    resolveProverConfig(network),
    connectorKeyMaterialProvider(keyLocation, keyMaterial),
  );
  return provider.check(serializedPreimage, keyLocation);
}

export async function provingProviderProve(
  network: NetworkConfig,
  serializedPreimage: Uint8Array,
  keyLocation: string,
  keyMaterial: ProvingKeyMaterialDTO,
  overwriteBindingInput?: bigint,
): Promise<Uint8Array> {
  const provider = createProvingProvider(
    resolveProverConfig(network),
    connectorKeyMaterialProvider(keyLocation, keyMaterial),
  );
  return provider.prove(serializedPreimage, keyLocation, overwriteBindingInput);
}

export async function txHistoryGet(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
  pageNumber: number,
  pageSize: number,
): Promise<HistoryEntry[]> {
  if (pageSize <= 0) return [];
  const wallet = await syncEnsure(seedHex, walletName, network);
  await waitForSyncedBalances(wallet, SYNC_WAIT_MS);
  const entries = await wallet.facade.getAllFromTxHistory();
  // Newest first. Entries can lack a timestamp (older/partial records) — sort
  // those to the end while keeping their relative order otherwise stable.
  const sorted = [...entries].sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0));
  const start = Math.max(0, pageNumber) * pageSize; // pageNumber is 0-based
  return sorted.slice(start, start + pageSize).map(toHistoryEntry);
}

// The wallet's own unshielded address, memoized: deriveAllAddressesFromSeed
// walks every role × network through the WASM encoders, which is too much to
// repeat at the activity feed's refresh cadence (one fetch per applied batch).
let cachedOwnAddress: { key: string; address: string } | null = null;
function ownUnshieldedAddress(seedHex: string, networkId: string): string {
  const key = `${networkId}/${seedHex}`;
  if (cachedOwnAddress?.key !== key) {
    cachedOwnAddress = {
      key,
      address: deriveAllAddressesFromSeed(seedHex).nightExternal.bech32m[networkId] ?? '',
    };
  }
  return cachedOwnAddress.address;
}

// The panel's activity feed. Unlike the connector's txHistoryGet this does NOT
// wait for sync: history is restored from its persisted cache when the engine
// starts, so the feed shows what's known immediately and fills in as sync
// applies newer transactions. Locally-submitted transactions merge in as
// pending rows until the indexer reports them applied.
export async function activityGet(
  seedHex: string,
  walletName: string,
  network: NetworkConfig,
): Promise<string> {
  const wallet = await syncEnsure(seedHex, walletName, network);
  const entries = await wallet.facade.getAllFromTxHistory();
  const ownAddress = ownUnshieldedAddress(seedHex, network.id);

  const store = new IdbSyncStateStore();
  const submissions = await loadSubmissions(store, network.id, walletName);
  const { entries: merged, prune } = mergeSubmissions(
    deriveActivity(entries, ownAddress),
    submissions,
    Date.now(),
  );
  if (prune.length > 0) {
    const kept = submissions.filter((tx) => !prune.includes(tx.hash));
    await saveSubmissions(store, network.id, walletName, kept).catch(() => {});
  }
  return serializeActivity(merged);
}
