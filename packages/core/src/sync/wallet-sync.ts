// Wallet sync engine using WalletFacade for real balance tracking.
// Caches serialized sync state via a SyncStateStore so subsequent launches
// are fast. This module must stay free of static node:*/ws imports and
// top-level side effects so it can be bundled for the browser.
// See NOTICE for attribution.

import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {DefaultConfiguration, WalletFacade, type FacadeState} from '@midnightntwrk/wallet-sdk/facade';
import {
  makeDefaultSubmissionService,
  type SubmissionService,
} from '@midnightntwrk/wallet-sdk/capabilities/submission';
// CustomDustWallet/CustomShieldedWallet let v8's dedup builders wrap the sync
// pipeline (see sdk-dedup); the plain wallets remain for non-deduped paths.
import {DustWallet, CustomDustWallet} from '@midnightntwrk/wallet-sdk/dust';
import {ShieldedWallet, CustomShieldedWallet} from '@midnightntwrk/wallet-sdk/shielded';
import {UnshieldedWallet, PublicKey, createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {InMemoryTransactionHistoryStorage} from '@midnightntwrk/wallet-sdk';
import {WalletEntrySchema, mergeWalletEntries} from '@midnightntwrk/wallet-sdk/facade';
import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import {resolveProverConfig, type NetworkConfig} from '../types/network.js';
import {createWalletProvingService} from '../proof/provider.js';
import {NIGHT_TOKEN_ID, formatNight} from '../types/tokens.js';
import {formatDustBalance} from '../wallet/balance-format.js';
import {ensureEmptyRefCache, preSeedNewWallet} from './preseed.js';
import {InMemorySyncStateStore, syncStateKey, type SyncStateStore, type WalletPart} from './sync-store.js';
import {dedupingShieldedBuilder, dedupingDustBuilder} from './sdk-dedup.js';
import {overallSyncProgress, type SubWallet} from './progress.js';
import {partsToSeed} from './preseed-parts.js';
import type {WalletKeys} from './operations.js';

// Re-exported so existing importers (core/browser barrels, CLI/TUI) keep working;
// the definitions live in the WASM-free ../types/tokens module.
export {NIGHT_TOKEN_ID, formatNight};

/**
 * A submission service that resolves as soon as the transaction is accepted
 * into the pool ('Submitted'), rather than blocking until 'Finalized' like the
 * SDK default.
 *
 * `WalletFacade.submitTransaction` always asks its submission service for
 * 'Finalized', so a send blocks the whole round-trip on block finalization
 * (12–60s+). In the extension that round-trip is a Chrome MV3 runtime message,
 * whose port can't outlive that wait — it closes, the UI sees "No response",
 * and shows a failure even though the transaction was submitted fine and lands.
 *
 * What matters for the send flow is that the transaction reached the pool;
 * inclusion/finalization is reflected afterwards through normal sync and tx
 * history. So we hand the facade a service that ignores the requested level and
 * always resolves at 'Submitted'. The facade still records the pending
 * transaction around this call (optimistic balances) and reverts it if
 * submission is rejected.
 */
function makeSubmittedOnlySubmissionService(
  relayURL: URL,
): SubmissionService<ledger.FinalizedTransaction> {
  const inner = makeDefaultSubmissionService<ledger.FinalizedTransaction>({relayURL});
  return {
    submitTransaction: ((tx: ledger.FinalizedTransaction) =>
      inner.submitTransaction(tx, 'Submitted')) as SubmissionService<ledger.FinalizedTransaction>['submitTransaction'],
    close: () => inner.close(),
  };
}

/**
 * WebSocket polyfill for Node.js (wallet SDK assumes browser WebSocket).
 * Browsers/service workers have a global WebSocket, so the `ws` package is
 * only loaded — lazily — when the global is missing.
 */
async function ensureWebSocket(): Promise<void> {
  if (typeof (globalThis as any).WebSocket !== 'undefined') return;
  // Specifier goes through a variable so bundlers can't statically follow it
  // into browser builds (browsers always have a global WebSocket anyway).
  const specifier = 'ws';
  const {WebSocket} = await import(/* @vite-ignore */ specifier);
  (globalThis as any).WebSocket = WebSocket;
}

// Suppress noisy SDK console + stdout output.
// The @polkadot/util logger writes directly to process.stdout, not console.
// Suppress known-noisy SDK log messages. Match specific strings only —
// never broad patterns like '_tag' that could swallow security-relevant errors.
const SDK_NOISE = [
  'RPC-CORE',
  'API-WS',
  'subscribeRuntimeVersion',
  'disconnected from',
  'Normal Closure',
  'Abnormal Closure',
  'Error processing tx history',
  'Wallet.Sync',
  'ws://localhost:9944',
];
function isSdkNoise(msg: string): boolean {
  return SDK_NOISE.some((pattern) => msg.includes(pattern));
}

let logSuppressionInstalled = false;

/**
 * Install console/stdout/stderr/unhandledRejection filters for SDK noise.
 * Deferred to first sync so importing this module has no side effects.
 *
 * The console half runs EVERYWHERE, including the extension's wallet worker.
 * It was Node-only for a long time, gated behind the `process` check below, so
 * the browser showed every `API-WS: disconnected … Abnormal Closure` the relay
 * produced — strings already on the curated SDK_NOISE list, filtered out of the
 * CLI and TUI but not out of the surface most users actually see.
 *
 * What CANNOT be silenced here: `WebSocket connection to '…' failed: <status>`.
 * Chrome emits that from the network stack, not from JavaScript, so no console
 * patch reaches it. That one is not benign anyway — it means the node is genuinely
 * unreachable, and the relay banner says so in the UI.
 */
function installLogSuppression(): void {
  if (logSuppressionInstalled) return;
  logSuppressionInstalled = true;

  // Node-only streams: the @polkadot/util logger writes directly to stdout there,
  // bypassing console entirely. No equivalent in a browser worker.
  if (typeof process !== 'undefined' && typeof process.stdout?.write === 'function') {
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, ...rest: any[]) => {
      if (typeof chunk === 'string' && isSdkNoise(chunk)) return true;
      return (origStdoutWrite as any)(chunk, ...rest);
    };

    // Also intercept stderr — SDK sync errors go through stderr as unhandled rejections
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, ...rest: any[]) => {
      if (typeof chunk === 'string' && isSdkNoise(chunk)) return true;
      return (origStderrWrite as any)(chunk, ...rest);
    };
  }

  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;
  const origConsoleLog = console.log;
  // Check all args for noise (SDK sometimes passes objects as later arguments)
  // Known Effect _tag values from the wallet SDK that are safe to suppress.
  const KNOWN_NOISE_TAGS = new Set(['Wallet.Sync', 'ApiDisconnected', 'WebSocketError']);

  function argsAreNoise(args: any[]): boolean {
    return args.some((a) => {
      if (typeof a === 'string') return isSdkNoise(a);
      // Effect errors: only suppress known-safe _tag values, not arbitrary ones
      if (a && typeof a === 'object' && typeof a._tag === 'string') {
        return KNOWN_NOISE_TAGS.has(a._tag) || isSdkNoise(a._tag);
      }
      // Stringified objects — check the string representation
      try {
        return isSdkNoise(String(a));
      } catch {
        return false;
      }
    });
  }
  console.error = (...args: any[]) => {
    if (argsAreNoise(args)) return;
    origConsoleError.apply(console, args);
  };
  console.warn = (...args: any[]) => {
    if (argsAreNoise(args)) return;
    origConsoleWarn.apply(console, args);
  };
  console.log = (...args: any[]) => {
    if (argsAreNoise(args)) return;
    origConsoleLog.apply(console, args);
  };

  // Suppress unhandled rejections from SDK sync retries — these are non-fatal
  // and the SDK handles reconnection internally. Node-only: a browser worker has
  // no process, and its equivalent (an 'unhandledrejection' event) is not
  // intercepted here because a swallowed rejection in the worker would hide
  // failures the extension has no other channel to report.
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;
  process.on('unhandledRejection', (reason: any) => {
    const tag = reason?._tag ?? '';
    const msg = reason?.message ?? String(reason ?? '');
    if (tag === 'Wallet.Sync' || isSdkNoise(msg) || isSdkNoise(tag)) {
      // Silently swallowed — SDK will retry
      return;
    }
    // Re-throw non-SDK rejections so they're visible
    origConsoleError.call(console, 'Unhandled rejection:', reason);
  });
}

const DUST_COST_PARAMETERS = {
  additionalFeeOverhead: 300_000_000_000_000n,
  feeBlocksMargin: 5,
};

export interface DustGeneration {
  balance: bigint;
  designated: bigint;
  ratePerDay: bigint;
  limit: bigint;
  fillTime: Date;
  numUtxos: number;
  registered: boolean;
  /** NIGHT (raw STAR) actually registered for generation — the sum of the
   *  registered UTXOs. Balance beyond this contributes no DUST capacity until
   *  it, too, is registered. */
  registeredNight: bigint;
  /** Creation time of the newest registered NIGHT UTXO, or null when none.
   *  Lets callers distinguish "generation records still settling" (recent)
   *  from a stale local dust view (old UTXOs with no records). */
  newestRegisteredAt: Date | null;
}

export interface SyncProgress {
  /** 0.0 to 1.0 */
  percentage: number;
  /** Estimated seconds remaining, or null if unknown */
  etaSeconds: number | null;
  /** Which sub-wallets are synced */
  shieldedSynced: boolean;
  unshieldedSynced: boolean;
  dustSynced: boolean;
  /** Which sub-wallet the percentage came from; null once synced. */
  slowest: SubWallet | null;
}

/** Per-sub-wallet sync progress as raw applied/total indices (mirrors midnight-wallet-cli). */
export interface SubWalletSyncProgress {
  applied: number;
  total: number;
}

export interface ShieldedCoinInfo {
  value: bigint;
  type: string;
}

export interface UnshieldedCoinInfo {
  value: bigint;
  type: string;
  registeredForDustGeneration: boolean;
}

export interface DustCoinInfo {
  generatedNow: bigint;
  maxCap: bigint;
  maxCapReachedAt: Date;
  /** Set when the underlying NIGHT UTXO has been deregistered. */
  dtime: Date | null;
}

export interface WalletCoinDetails {
  shielded: {available: ShieldedCoinInfo[]; pending: ShieldedCoinInfo[]};
  unshielded: {available: UnshieldedCoinInfo[]; pending: UnshieldedCoinInfo[]};
  dust: {available: DustCoinInfo[]; pending: DustCoinInfo[]};
}

export interface SubWalletProgress {
  shielded: SubWalletSyncProgress;
  unshielded: SubWalletSyncProgress;
  dust: SubWalletSyncProgress;
}

export interface WalletBalances {
  shielded: Record<string, bigint>;
  unshielded: Record<string, bigint>;
  dust: bigint;
  dustGeneration: DustGeneration | null;
  syncProgress: SyncProgress;
  synced: boolean;
  /** Per-coin breakdown (matches midnight-wallet-cli's WalletStateView). */
  coins: WalletCoinDetails;
  /** Per-sub-wallet sync progress as raw applied/total. */
  subProgress: SubWalletProgress;
}

export const EMPTY_COINS: WalletCoinDetails = {
  shielded: {available: [], pending: []},
  unshielded: {available: [], pending: []},
  dust: {available: [], pending: []},
};

export const EMPTY_SUB_PROGRESS: SubWalletProgress = {
  shielded: {applied: 0, total: 0},
  unshielded: {applied: 0, total: 0},
  dust: {applied: 0, total: 0},
};

export interface SyncedWallet {
  facade: WalletFacade;
  balances: WalletBalances;
  stop: () => Promise<void>;
  refresh: () => Promise<WalletBalances>;
  /** Subscribe to progressive balance updates. Returns unsubscribe function. */
  subscribe: (cb: (balances: WalletBalances) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Sync state cache — SyncStateStore-backed, per wallet + network
// ---------------------------------------------------------------------------

let defaultStore: SyncStateStore | null = null;

/**
 * Resolve the sync-state store: explicit option → Node filesystem store
 * (legacy ~/.moth layout, loaded lazily so browser bundles never pull in
 * node:fs) → volatile in-memory store.
 */
export async function resolveSyncStore(explicit?: SyncStateStore): Promise<SyncStateStore> {
  if (explicit) return explicit;
  if (defaultStore) return defaultStore;
  let store: SyncStateStore;
  if (typeof process !== 'undefined' && process.versions?.node) {
    // Specifier goes through a variable so bundlers can't statically follow
    // the node:fs-backed store into browser builds.
    const specifier = './node-sync-store.js';
    const mod = await import(/* @vite-ignore */ specifier);
    store = new mod.NodeSyncStateStore();
  } else {
    store = new InMemorySyncStateStore();
  }
  defaultStore = store;
  return store;
}

function loadCachedState(
  store: SyncStateStore,
  walletName: string,
  networkId: string,
  part: WalletPart
): Promise<string | null> {
  return store.get(syncStateKey(networkId, walletName, part));
}

function saveCachedState(
  store: SyncStateStore,
  walletName: string,
  networkId: string,
  part: WalletPart,
  state: string
): Promise<void> {
  return store.put(syncStateKey(networkId, walletName, part), state);
}

// Store-based (async) — keeps the browser (IndexedDB) path working; the Node
// filesystem cache is a concrete SyncStateStore behind resolveSyncStore. v8's
// sync fs-based readWalletCacheState/pre-seed bridge is re-expressed against
// this async store in preseed.ts rather than reintroduced here.
async function evictCachedState(
  store: SyncStateStore,
  walletName: string,
  networkId: string,
  part: WalletPart
): Promise<void> {
  try {
    await store.delete(syncStateKey(networkId, walletName, part));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function toWsUrl(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

// ---------------------------------------------------------------------------
// Wallet sync
// ---------------------------------------------------------------------------

/** Tuning for how the SDK groups sync events into synchronous WASM applies. */
export interface BatchUpdatesOptions {
  /** Max events applied per batch. Bigger = faster sync, longer main-thread blocks. */
  size?: number;
  /** Max ms to wait for a full batch before emitting a partial one. */
  timeout?: number;
  /** Min ms between consecutive batches — lets the event loop breathe. */
  spacing?: number;
}

export interface WalletSyncOptions {
  /** Where serialized sync state is cached. Defaults to the filesystem store in Node, in-memory elsewhere. */
  syncStore?: SyncStateStore;
  /**
   * Event-batching overrides. Defaults favour throughput (size 500), which is
   * right for Node CLIs; UI hosts that share a thread with rendering should
   * pass smaller batches so each synchronous WASM apply stays short.
   */
  batchUpdates?: BatchUpdatesOptions;
}

/** Bound on the SDK's own teardown. A healthy stop takes tens of milliseconds, so
 *  this only ever elapses for one that will never finish. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * Bring up the WalletFacade (shielded + unshielded + dust) and start syncing.
 * Takes `walletKeys` (the typed bundle derived once at unlock — Option A, the
 * raw seed is never threaded here). Pre-seed of brand-new wallets derives the
 * bundle up front (see preseed.ts) and calls this directly.
 */
/** A sub-wallet's own fraction, for the progress line. `done` wins over the
 *  counters: a sub-wallet with nothing to apply is complete, not stalled. */
function subPct(sub: {applied: number; total: number}, done: boolean): string {
  if (done) return '100%';
  return sub.total > 0 ? `${Math.round(Math.min(1, sub.applied / sub.total) * 100)}%` : '100%';
}

/**
 * Re-assert the SDK's global network id.
 *
 * `startWalletSync` sets it, and every write path sets it again at its own
 * boundary (see operations.ts and contract/*), because it is process-global and
 * whatever ran last owns it. A caller that reuses an already-started sync —
 * WarmSyncPool handing a facade back after the session visited another network —
 * skips `startWalletSync` entirely, so it has to make the same assertion the
 * cold path would have made, or the reused wallet encodes addresses for the
 * network it is no longer on.
 */
export function applyNetworkId(networkId: string): void {
  setNetworkId(networkId);
}

export async function startWalletSync(
  keys: WalletKeys,
  network: NetworkConfig,
  onProgress?: (msg: string) => void,
  walletName?: string,
  isNewWallet?: boolean,
  /** Chain tip index at wallet creation time. Skips scanning blocks before this index on first sync. */
  birthday?: number,
  options?: WalletSyncOptions
): Promise<SyncedWallet> {
  installLogSuppression();
  await ensureWebSocket();
  const store = await resolveSyncStore(options?.syncStore);

  setNetworkId(network.id);
  onProgress?.('Deriving keys...');

  const name = walletName ?? 'default';

  // Option A: keys arrive pre-derived; the seed was dropped at unlock.
  const shieldedSecretKeys = keys.shieldedSecretKeys;
  const dustSecretKey = keys.dustSecretKey;
  const keystore = createKeystore(keys.nightExternalKey, network.id);

  const indexerHttpUrl = network.indexerUrl;
  const indexerWsUrl = toWsUrl(indexerHttpUrl) + '/ws';
  const relayURL = new URL(toWsUrl(network.nodeUrl));
  const prover = resolveProverConfig(network);

  // Transaction history follows the same cache lifecycle as the sub-wallet
  // states below: restore from the store so history survives restarts, sync
  // only fills in what happened since.
  const txHistoryStorage = await loadHistoryStorage(store, name, network.id, onProgress);

  // Cast confined to the SDK's config intersection: the literal can't satisfy
  // DefaultTransactionHistoryConfiguration structurally, so it's typed as the
  // factory's config type, matching the prior runtime behaviour.
  const walletCfg: DefaultConfiguration = {
    networkId: network.id,
    indexerClientConnection: {indexerHttpUrl, indexerWsUrl},
    relayURL,
    // Shared transaction history storage for all sub-wallets (v4 SDK requirement)
    txHistoryStorage,
    costParameters: DUST_COST_PARAMETERS,
    batchUpdates: {
      size: options?.batchUpdates?.size ?? 500,
      timeout: options?.batchUpdates?.timeout ?? 500,
      spacing: options?.batchUpdates?.spacing ?? 50,
    },
  };

  // --- Pre-seed: fill in whichever sub-wallet caches are missing ---
  //
  // Per-part, not all-or-nothing. This used to gate on the SHIELDED cache alone,
  // as a proxy for "this wallet has no state yet". That proxy broke exactly where
  // it mattered most: a DUST rebuild evicts the dust cache and nothing else, so
  // shielded was still present, the gate was false, and dust walked all 1.4M
  // events from genesis — 78.6 min on preprod — with a perfectly good reference
  // sitting unused. "Rebuild records" is what a user reaches for when dust looks
  // wrong, so the narrow, careful-looking operation was the slowest to recover
  // while a full indexer-change wipe was fast.
  //
  // Mixed heights are fine, and are tested rather than assumed: the sub-wallets
  // carry independent cursors, so dust can restore at the reference's height
  // while shielded and unshielded resume at tip and each catches up on its own
  // stream. Measured on preview: dust rewound to the reference (64,771) alongside
  // shielded at tip (64,982) reached fully synced in 1.0s with identical balances.
  const cached = {
    shielded: await loadCachedState(store, name, network.id, 'shielded'),
    unshielded: await loadCachedState(store, name, network.id, 'unshielded'),
    dust: await loadCachedState(store, name, network.id, 'dust'),
  };
  const missingParts = partsToSeed(cached);

  if ((isNewWallet || birthday) && missingParts.length > 0) {
    onProgress?.('Pre-seeding new wallet from reference...');
    try {
      const emptyRef = await ensureEmptyRefCache(network, onProgress, store);
      // SAFETY: only seed a wallet that cannot have had activity before the
      // reference's height. The reference holds the chain's state at that height,
      // so seeding an older wallet would start it past its own history and lose
      // funds from view. `birthday` is the wallet's creation height, so a wallet
      // created after the reference was built is safe; anything else — a restore
      // from mnemonic, a wallet whose cache was cleared or evicted, or a missing
      // birthday — must take the slow path instead. Without this, the guard above
      // (`isNewWallet || birthday`) admits any wallet that merely lacks a cache.
      const seedable = emptyRef !== null && birthday !== undefined && emptyRef.height <= birthday;
      if (emptyRef && !seedable) {
        onProgress?.(
          birthday === undefined
            ? 'Pre-seed: no wallet birthday to compare — syncing from genesis'
            : `Pre-seed: reference is newer than this wallet (height ${emptyRef.height} > birthday ${birthday}) — syncing from genesis`,
        );
      }
      if (emptyRef && seedable) {
        const preSeeded = preSeedNewWallet(keys, network.id, emptyRef);
        if (preSeeded) {
          // Only where absent. A part that already has a cache is at least as
          // far along as the reference, so overwriting it would throw away
          // progress — and after a DUST rebuild, shielded and unshielded are
          // precisely the parts that must be left alone.
          const seeded: string[] = [];
          if (!cached.shielded) {
            await saveCachedState(store, name, network.id, 'shielded', preSeeded.shielded);
            seeded.push('shielded');
          }
          if (!cached.unshielded) {
            await saveCachedState(store, name, network.id, 'unshielded', preSeeded.unshielded);
            seeded.push('unshielded');
          }
          if (!cached.dust && preSeeded.dust) {
            await saveCachedState(store, name, network.id, 'dust', preSeeded.dust);
            seeded.push('dust');
          }
          onProgress?.(
            seeded.length > 0
              ? `Pre-seed complete — ${seeded.join(' + ')} at chain tip`
              : 'Pre-seed: nothing to seed, every sub-wallet already cached',
          );
        }
      }
    } catch (err) {
      onProgress?.(`Pre-seed failed, will sync from genesis: ${err}`);
    }
  }

  // --- Shielded wallet: try restore from cache ---
  // Use CustomShieldedWallet with a deduping syncCapability so that
  // re-sent boundary events from the indexer don't trip the WASM tree
  // (see sync/sdk-dedup.ts for the upstream bug context).
  onProgress?.('Starting shielded wallet...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shieldedBuilder = dedupingShieldedBuilder() as any;
  let shieldedWallet: ShieldedWallet | undefined;
  let restoredFromCache = false;
  const savedShielded = await loadCachedState(store, name, network.id, 'shielded');
  if (savedShielded) {
    try {
      onProgress?.('Restoring shielded state from cache...');
      shieldedWallet = CustomShieldedWallet(walletCfg, shieldedBuilder).restore(savedShielded);
      restoredFromCache = true;
    } catch {
      onProgress?.('Shielded cache corrupted, syncing from genesis...');
      await evictCachedState(store, name, network.id, 'shielded');
    }
  }
  if (!shieldedWallet) {
    shieldedWallet = CustomShieldedWallet(walletCfg, shieldedBuilder).startWithSecretKeys(shieldedSecretKeys);
  }

  // --- Unshielded wallet: try restore from cache ---
  onProgress?.('Starting unshielded wallet...');
  let unshieldedWallet: UnshieldedWallet | undefined;
  const savedUnshielded = await loadCachedState(store, name, network.id, 'unshielded');
  if (savedUnshielded) {
    try {
      onProgress?.('Restoring unshielded state from cache...');
      unshieldedWallet = UnshieldedWallet(walletCfg).restore(savedUnshielded);
    } catch {
      onProgress?.('Unshielded cache corrupted, syncing from genesis...');
      await evictCachedState(store, name, network.id, 'unshielded');
    }
  }
  if (!unshieldedWallet) {
    unshieldedWallet = UnshieldedWallet(walletCfg).startWithPublicKey(PublicKey.fromKeyStore(keystore));
  }

  // --- Dust wallet: try restore from cache ---
  // Same deduping wrapper as the shielded wallet — the dust SDK has the
  // same boundary-event off-by-one in its applyUpdate.
  onProgress?.('Starting dust wallet...');
  const dustCfg = {
    networkId: network.id,
    costParameters: DUST_COST_PARAMETERS,
    indexerClientConnection: {indexerHttpUrl, indexerWsUrl},
    txHistoryStorage,
  } as Parameters<typeof DustWallet>[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dustBuilder = dedupingDustBuilder() as any;
  let dustWallet: DustWallet | undefined;
  const savedDust = await loadCachedState(store, name, network.id, 'dust');
  if (savedDust) {
    try {
      onProgress?.('Restoring dust state from cache...');
      dustWallet = CustomDustWallet(dustCfg, dustBuilder).restore(savedDust);
    } catch {
      onProgress?.('Dust cache corrupted, syncing from genesis...');
      await evictCachedState(store, name, network.id, 'dust');
    }
  }
  if (!dustWallet) {
    dustWallet = CustomDustWallet(dustCfg, dustBuilder).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust
    );
  }

  if (restoredFromCache) {
    onProgress?.('Sync state restored from cache — catching up...');
  }

  // --- WalletFacade ---
  onProgress?.('Initializing wallet facade...');
  const facade = await WalletFacade.init({
    configuration: walletCfg,
    // The SDK defaults to a proof server. Supply the service explicitly so
    // WASM mode follows the documented makeWasmProvingService() path.
    provingService: () => createWalletProvingService(prover),
    // Resolve submissions at 'Submitted' instead of the default 'Finalized' so a
    // send doesn't block its message round-trip on finalization — see
    // makeSubmittedOnlySubmissionService.
    submissionService: (cfg) => makeSubmittedOnlySubmissionService(cfg.relayURL),
    shielded: () => shieldedWallet!,
    unshielded: () => unshieldedWallet!,
    dust: () => dustWallet!,
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);
  onProgress?.('Syncing with network...');

  // Subscribe to progressive state updates — don't block on full sync.
  // Emit partial balances immediately so the UI shows shielded/unshielded
  // balances as soon as those sub-wallets are ready, while dust keeps scanning.
  const emptySyncProgress: SyncProgress = {
    percentage: 0,
    etaSeconds: null,
    slowest: null,
    shieldedSynced: false,
    unshieldedSynced: false,
    dustSynced: false,
  };
  let latestBalances: WalletBalances = {
    shielded: {},
    unshielded: {},
    dust: 0n,
    dustGeneration: null,
    syncProgress: emptySyncProgress,
    synced: false,
    coins: EMPTY_COINS,
    subProgress: EMPTY_SUB_PROGRESS,
  };
  let emissionCount = 0;
  const subscribers: Array<(b: WalletBalances) => void> = [];
  const syncStartTime = Date.now();
  let lastProgressPct = 0;
  const progressBaseline: ProgressBaseline = {value: null};

  let hasSavedCache = false;
  let lastCacheSaveTime = 0;
  const subscription = facade
    .state()
    .pipe(Rx.auditTime(1000))
    .subscribe({
      next: (s: FacadeState) => {
        emissionCount++;
        const balances = extractBalancesPartial(s, syncStartTime, lastProgressPct, progressBaseline, latestBalances);
        latestBalances = balances;
        lastProgressPct = balances.syncProgress.percentage;

        const nightTotal = (balances.unshielded[NIGHT_TOKEN_ID] ?? 0n) + (balances.shielded[NIGHT_TOKEN_ID] ?? 0n);
        const pct = Math.round(balances.syncProgress.percentage * 100);
        const eta = balances.syncProgress.etaSeconds;
        const etaStr = eta !== null ? formatEta(eta) : '';
        const slowest = balances.syncProgress.slowest;
        const slowestLabel = slowest ? ` (${slowest})` : '';

        if (
          emissionCount % 50 === 0 ||
          emissionCount <= 3 ||
          balances.synced ||
          pct !== Math.round(lastProgressPct * 100)
        ) {
          // DUST is denominated in SPECKS (10^15 per DUST); NIGHT in STARS
          // (10^6). formatNight was being applied to both, so every DUST figure
          // ever logged was wrong by a factor of 10^9 — and plausibly wrong,
          // which is worse. formatDustBalance has existed and been exported the
          // whole time; this line simply predates it.
          //
          // The progress line names the sub-wallet the percentage belongs to.
          // Reporting the slowest sub-wallet's fraction with no attribution, and
          // suffixing it with a NIGHT balance, made "syncing 27% — NIGHT: 8378"
          // read as "NIGHT is 27% synced" while the panel showed shielded and
          // unshielded at 100%. Balances belong on the synced line, once.
          onProgress?.(
            balances.synced
              ? `● synced — NIGHT: ${formatNight(nightTotal)}, DUST: ${formatDustBalance(balances.dust)}`
              : `○ syncing ${pct}%${slowestLabel} — shielded ${subPct(balances.subProgress.shielded, balances.syncProgress.shieldedSynced)}, unshielded ${subPct(balances.subProgress.unshielded, balances.syncProgress.unshieldedSynced)}, dust ${subPct(balances.subProgress.dust, balances.syncProgress.dustSynced)}${etaStr ? ` (${etaStr} remaining)` : ''}`
          );
        }

        for (const cb of subscribers) {
          try {
            cb(balances);
          } catch {
            /* subscriber error */
          }
        }

        // Save sync cache every 60s so progress survives ctrl-C / crashes
        const cacheNow = Date.now();
        if (cacheNow - lastCacheSaveTime > 60_000) {
          lastCacheSaveTime = cacheNow;
          saveCache(store, facade, txHistoryStorage, name, network.id).catch(() => {});
        }

        if (balances.synced && !hasSavedCache) {
          hasSavedCache = true;
          saveCache(store, facade, txHistoryStorage, name, network.id).catch(() => {});
        }
      },
      error: (err: any) => {
        onProgress?.(`Sync error: ${err}`);
      },
    });

  // Wait briefly for first emission so we have something to return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    const earlyCheck = facade
      .state()
      .pipe(Rx.first())
      .subscribe((s: FacadeState) => {
        latestBalances = extractBalancesPartial(s);
        clearTimeout(timeout);
        earlyCheck.unsubscribe();
        resolve();
      });
  });

  const refresh = async (): Promise<WalletBalances> => {
    return latestBalances;
  };

  const subscribe = (cb: (b: WalletBalances) => void): (() => void) => {
    subscribers.push(cb);
    // Emit current state immediately
    cb(latestBalances);
    return () => {
      const idx = subscribers.indexOf(cb);
      if (idx >= 0) subscribers.splice(idx, 1);
    };
  };

  const stop = async () => {
    subscription.unsubscribe();
    await saveCache(store, facade, txHistoryStorage, name, network.id).catch(() => {});

    // `facade.stop()` never settles against an unreachable node: it awaits a
    // Polkadot client created with `throwOnConnect: false`. saveCache ran first.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), STOP_TIMEOUT_MS);
      facade.stop().then(
        () => resolve(false),
        () => resolve(false)
      );
    });
    clearTimeout(timer);
    if (timedOut) {
      onProgress?.(`Sync stop timed out after ${STOP_TIMEOUT_MS / 1000}s — abandoning SDK teardown`);
    }
  };

  // `balances` is exposed as a getter so callers (notably the daemon's
  // `getBalances`) always read the live snapshot. A plain property
  // would freeze the reference at the moment startWalletSync returned —
  // every subsequent sync update reassigns `latestBalances` to a new
  // object, so a snapshotted property would never reflect any of them.
  return {
    facade,
    get balances(): WalletBalances {
      return latestBalances;
    },
    stop,
    refresh,
    subscribe,
  };
}

/**
 * Restore the shared transaction history storage from its cached serialization,
 * mirroring the sub-wallet restore path: use the cache when it decodes, evict
 * and start empty when it doesn't (sync rebuilds it from the indexer).
 */
async function loadHistoryStorage(
  store: SyncStateStore,
  walletName: string,
  networkId: string,
  onProgress?: (msg: string) => void
) {
  const saved = await loadCachedState(store, walletName, networkId, 'history');
  if (saved) {
    try {
      onProgress?.('Restoring transaction history from cache...');
      return InMemoryTransactionHistoryStorage.restore(saved, WalletEntrySchema, mergeWalletEntries);
    } catch {
      onProgress?.('Transaction history cache corrupted, rebuilding from sync...');
      await evictCachedState(store, walletName, networkId, 'history');
    }
  }
  return new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
}

async function saveCache(
  store: SyncStateStore,
  facade: WalletFacade,
  history: {serialize(): Promise<string>},
  walletName: string,
  networkId: string
): Promise<void> {
  try {
    const [sh, un, du, hi] = await Promise.all([
      facade.shielded.state
        .pipe(Rx.first())
        .toPromise()
        .then((s) => s?.capabilities?.serialization?.serialize?.(s.state) ?? null),
      facade.unshielded.state
        .pipe(Rx.first())
        .toPromise()
        .then((s) => s?.capabilities?.serialization?.serialize?.(s.state) ?? null),
      facade.dust.state
        .pipe(Rx.first())
        .toPromise()
        .then((s) => s?.capabilities?.serialization?.serialize?.(s.state) ?? null),
      history.serialize().catch(() => null),
    ]).catch(() => [null, null, null, null]);
    if (sh) await saveCachedState(store, walletName, networkId, 'shielded', sh);
    if (un) await saveCachedState(store, walletName, networkId, 'unshielded', un);
    if (du) await saveCachedState(store, walletName, networkId, 'dust', du);
    if (hi) await saveCachedState(store, walletName, networkId, 'history', hi);
  } catch {
    /* best effort */
  }
}

/**
 * Where a sync session started, for the ETA.
 *
 * A resumed sync begins part-way through — dust restores from cache constantly —
 * and an estimate built from cumulative percentage over session elapsed reads
 * that as an impossibly fast rate. Held per session rather than per module: the
 * daemon and TUI sync several wallets in one process, and a shared baseline
 * would give each of them the others' starting point.
 */
export interface ProgressBaseline {
  value: {fraction: number; elapsedMs: number} | null;
}

function extractBalancesPartial(
  state: FacadeState,
  syncStartTime = 0,
  prevPct = 0,
  baseline?: ProgressBaseline,
  /**
   * The last snapshot, carried forward where this emission says nothing.
   *
   * A facade emission is not always a complete picture: a sub-wallet's slice can
   * be absent or throw mid-read, and treating that as "zero of everything" made
   * the TUI alternate about once a second between the real figures and
   * `synced · 0 / 0` with no balance. Progress does not go backwards inside a
   * session, so the previous value is a better answer than a default.
   */
  previous?: WalletBalances,
): WalletBalances {
  let shielded: Record<string, bigint> = {};
  let unshielded: Record<string, bigint> = {};
  let dust = 0n;
  let dustGeneration: DustGeneration | null = null;
  let synced = false;

  // Per-sub-wallet sync status
  let shieldedSynced = false;
  let unshieldedSynced = false;
  let dustSynced = false;

  // Per-coin breakdown
  const coins: WalletCoinDetails = {
    shielded: {available: [], pending: []},
    unshielded: {available: [], pending: []},
    dust: {available: [], pending: []},
  };

  // Per-sub-wallet raw sync progress (applied/total)
  const subProgress: SubWalletProgress = {
    shielded: {applied: 0, total: 0},
    unshielded: {applied: 0, total: 0},
    dust: {applied: 0, total: 0},
  };

  try {
    synced = state.isSynced === true;
  } catch {
    /* */
  }

  // Coins and progress read separately: they come from different parts of the
  // emission, and a throw in the coin loop used to skip the progress assignment
  // below it, leaving {applied: 0, total: 0} — which `fraction()` reads as
  // COMPLETE, so a mid-sync wallet rendered as "synced · 0 / 0".
  try {
    const sb = state.shielded?.balances;
    if (sb && typeof sb === 'object') shielded = sb as Record<string, bigint>;
    for (const c of state.shielded?.availableCoins ?? []) {
      coins.shielded.available.push({value: c.coin?.value ?? 0n, type: c.coin?.type ?? ''});
    }
    for (const c of state.shielded?.pendingCoins ?? []) {
      coins.shielded.pending.push({value: c.coin?.value ?? 0n, type: c.coin?.type ?? ''});
    }
  } catch {
    /* shielded coins not ready */
  }

  try {
    // Sub-progress — v4 SDK exposes a SyncProgress on `progress`. The abstractions package
    // defines: appliedIndex, highestRelevantWalletIndex, highestIndex, highestRelevantIndex.
    const sp = state.shielded?.progress;
    const shApplied = sp?.appliedIndex ?? 0n;
    const shTotal = sp?.highestRelevantWalletIndex ?? 0n;
    subProgress.shielded = {applied: Number(shApplied), total: Number(shTotal)};
    if (typeof sp?.isStrictlyComplete === 'function') {
      shieldedSynced = sp.isStrictlyComplete();
    } else if (shTotal > 0n && shApplied >= shTotal) {
      shieldedSynced = true;
    }
  } catch {
    /* shielded not ready */
  }

  try {
    const ub = state.unshielded?.balances;
    // Clone: we fold booked (pending) inputs into the displayed balance below
    // and must not mutate the SDK's own state object.
    if (ub && typeof ub === 'object') unshielded = { ...(ub as Record<string, bigint>) };
    // Per-coin breakdown
    for (const c of state.unshielded?.availableCoins ?? []) {
      coins.unshielded.available.push({
        value: c.utxo?.value ?? 0n,
        type: c.utxo?.type ?? '',
        registeredForDustGeneration: c.meta?.registeredForDustGeneration === true,
      });
    }
    for (const c of state.unshielded?.pendingCoins ?? []) {
      const value = c.utxo?.value ?? 0n;
      const type = c.utxo?.type ?? '';
      coins.unshielded.pending.push({
        value,
        type,
        registeredForDustGeneration: c.meta?.registeredForDustGeneration === true,
      });
      // Count booked inputs toward the displayed balance. A send or DUST
      // registration reserves its own NIGHT UTxOs (moved available→pending)
      // while the transaction is in flight, then they settle back to the
      // wallet on apply — so leaving them out flashes the balance down to zero
      // mid-registration. Unshielded pending holds ONLY these booked inputs,
      // never incoming coins, so this can't over-count receipts.
      unshielded[type] = (unshielded[type] ?? 0n) + value;
    }
    // v4 SDK unshielded SyncProgress: { appliedId, highestTransactionId, isConnected }
    const up = state.unshielded?.progress;
    const unApplied = up?.appliedId ?? 0n;
    const unTotal = up?.highestTransactionId ?? 0n;
    subProgress.unshielded = {applied: Number(unApplied), total: Number(unTotal)};
    if (typeof up?.isStrictlyComplete === 'function') {
      unshieldedSynced = up.isStrictlyComplete();
    } else if (unTotal > 0n && unApplied >= unTotal) {
      unshieldedSynced = true;
    } else if (synced) {
      unshieldedSynced = true;
    }
  } catch {
    /* unshielded not ready */
  }

  try {
    const d = state.dust?.balance?.(new Date());
    if (typeof d === 'bigint') dust = d;
    // Dust sub-wallet synced check
    if (synced) dustSynced = true;
    // Per-coin breakdown — dust coins carry max-cap + dtime
    for (const c of state.dust?.availableCoins ?? []) {
      coins.dust.available.push({
        generatedNow: c.generatedNow ?? 0n,
        maxCap: c.maxCap ?? 0n,
        maxCapReachedAt: c.maxCapReachedAt instanceof Date ? c.maxCapReachedAt : new Date(c.maxCapReachedAt ?? 0),
        dtime: c.dtime ? (c.dtime instanceof Date ? c.dtime : new Date(c.dtime)) : null,
      });
    }
    for (const c of state.dust?.pendingCoins ?? []) {
      coins.dust.pending.push({
        generatedNow: c.generatedNow ?? 0n,
        maxCap: c.maxCap ?? 0n,
        maxCapReachedAt: c.maxCapReachedAt instanceof Date ? c.maxCapReachedAt : new Date(c.maxCapReachedAt ?? 0),
        dtime: c.dtime ? (c.dtime instanceof Date ? c.dtime : new Date(c.dtime)) : null,
      });
    }
    // v4 SDK dust SyncProgress shares the abstractions shape with shielded
    const dp = state.dust?.progress;
    const duApplied = dp?.appliedIndex ?? 0n;
    const duTotal = dp?.highestRelevantWalletIndex ?? 0n;
    subProgress.dust = {applied: Number(duApplied), total: Number(duTotal)};
    if (typeof dp?.isStrictlyComplete === 'function') {
      dustSynced = dp.isStrictlyComplete();
    } else if (duTotal > 0n && duApplied >= duTotal) {
      dustSynced = true;
    } else if (synced) {
      dustSynced = true;
    }
  } catch {
    /* dust not ready */
  }

  // Overall progress: the slowest sub-wallet, clamped below 100% until actually
  // synced. Arithmetic lives in ./progress.ts so it is unit-testable without WASM.
  const {percentage, etaSeconds, slowest} = overallSyncProgress({
    shielded: subProgress.shielded,
    unshielded: subProgress.unshielded,
    dust: subProgress.dust,
    shieldedSynced,
    unshieldedSynced,
    dustSynced,
    synced,
    elapsedMs: syncStartTime > 0 ? Date.now() - syncStartTime : 0,
    baseline: baseline?.value ?? undefined,
  });

  // percentage/etaSeconds already account for `synced` (see overallSyncProgress);
  // this only reconciles the per-sub-wallet flags with the facade's own verdict.
  if (synced) {
    shieldedSynced = true;
    unshieldedSynced = true;
    dustSynced = true;
  }

  // Creation time of the newest UTXO, tolerant of absent metadata.
  const newestCtime = (utxos: ReadonlyArray<{meta?: {ctime?: Date}}>): Date | null =>
    utxos.reduce<Date | null>((newest, c) => {
      const ctime = c.meta?.ctime;
      return ctime && (!newest || ctime > newest) ? ctime : newest;
    }, null);

  // Extract DUST generation info from the facade's dust sub-wallet state.
  // This matches mn-tui's extractDustGeneration pattern.
  try {
    const nightRatio = ledger.LedgerParameters.initialParameters().dust.nightDustRatio as bigint;
    // v4 API: availableCoins is a property returning DustFullInfo[]
    const coins = state.dust.availableCoins.filter((coin) => coin.maxCap > 0n);

    if (coins.length > 0) {
      let limitRaw = 0n;
      let ratePerDay = 0n;
      let fillTime = new Date(0);
      for (const coin of coins) {
        limitRaw += coin.maxCap;
        ratePerDay += coin.rate * 86_400n;
        const cap = coin.maxCapReachedAt;
        if (cap > fillTime) fillTime = cap;
      }

      // Registered NIGHT UTXOs — their sum is the exact backing of the cap;
      // balance beyond it is unregistered and generates nothing.
      const registeredUtxos = state.unshielded.availableCoins.filter(
        (c) => c.utxo?.type === NIGHT_TOKEN_ID && c.meta?.registeredForDustGeneration === true
      );
      const registeredNight = registeredUtxos.reduce((sum, c) => sum + (c.utxo?.value ?? 0n), 0n);

      dustGeneration = {
        balance: dust,
        designated: nightRatio > 0n ? limitRaw / nightRatio : 0n,
        ratePerDay,
        limit: limitRaw,
        fillTime,
        numUtxos: coins.length,
        registered: registeredUtxos.length > 0 || coins.length > 0,
        registeredNight,
        newestRegisteredAt: newestCtime(registeredUtxos),
      };
    } else {
      // Check if any UTXOs are registered even if no dust coins yet
      const registeredUtxos = state.unshielded.availableCoins.filter(
        (c) => c.utxo?.type === NIGHT_TOKEN_ID && c.meta?.registeredForDustGeneration === true
      );
      dustGeneration = {
        balance: dust,
        designated: 0n,
        ratePerDay: 0n,
        limit: 0n,
        fillTime: new Date(0),
        numUtxos: 0,
        registered: registeredUtxos.length > 0,
        registeredNight: registeredUtxos.reduce((sum, c) => sum + (c.utxo?.value ?? 0n), 0n),
        newestRegisteredAt: newestCtime(registeredUtxos),
      };
    }
  } catch {
    /* dust generation info not available */
  }

  // Carry forward anything this emission did not report. Progress within a
  // session only moves forward, so a part that reported 498,519/498,519 a second
  // ago has not become 0/0 — the emission simply said nothing about it. Applied
  // per part, because emissions are routinely partial in exactly this way.
  if (previous) {
    for (const part of ['shielded', 'unshielded', 'dust'] as const) {
      const now = subProgress[part];
      const before = previous.subProgress[part];
      if (now.total === 0 && before.total > 0) subProgress[part] = before;
      else if (now.applied === 0 && before.applied > now.applied && now.total === before.total) {
        subProgress[part] = {applied: before.applied, total: now.total};
      }
    }
    // Same reasoning for the balances themselves: an empty map here means this
    // emission carried none, not that the wallet was emptied.
    if (Object.keys(shielded).length === 0 && Object.keys(previous.shielded).length > 0) shielded = previous.shielded;
    if (Object.keys(unshielded).length === 0 && Object.keys(previous.unshielded).length > 0) unshielded = previous.unshielded;
    if (dust === 0n && previous.dust > 0n) dust = previous.dust;
    if (coins.shielded.available.length === 0 && previous.coins.shielded.available.length > 0) coins.shielded = previous.coins.shielded;
    if (coins.unshielded.available.length === 0 && previous.coins.unshielded.available.length > 0) coins.unshielded = previous.coins.unshielded;
    if (coins.dust.available.length === 0 && previous.coins.dust.available.length > 0) coins.dust = previous.coins.dust;
    // A sub-wallet that was strictly complete does not stop being complete.
    shieldedSynced = shieldedSynced || previous.syncProgress.shieldedSynced;
    unshieldedSynced = unshieldedSynced || previous.syncProgress.unshieldedSynced;
    dustSynced = dustSynced || previous.syncProgress.dustSynced;
  }

  // First usable sample is the session's starting point. Captured after the
  // fraction is known and only once, so the rate below is measured over work
  // this session actually did.
  if (baseline && baseline.value === null && !synced && percentage > 0 && percentage < 0.995) {
    baseline.value = {fraction: percentage, elapsedMs: syncStartTime > 0 ? Date.now() - syncStartTime : 0};
  }

  const syncProgress: SyncProgress = {percentage, etaSeconds, slowest, shieldedSynced, unshieldedSynced, dustSynced};
  return {shielded, unshielded, dust, dustGeneration, syncProgress, synced, coins, subProgress};
}

function extractBalances(state: FacadeState): WalletBalances {
  const partial = extractBalancesPartial(state);
  return {
    ...partial,
    synced: true,
    syncProgress: {percentage: 1, etaSeconds: 0, slowest: null, shieldedSynced: true, unshieldedSynced: true, dustSynced: true},
  };
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Clear cached sync state for a wallet on a specific network.
 * Useful after a devnet genesis reset or corrupted state.
 */
export async function clearSyncCache(walletName: string, networkId: string, store?: SyncStateStore): Promise<void> {
  const resolved = await resolveSyncStore(store);
  await evictCachedState(resolved, walletName, networkId, 'shielded');
  await evictCachedState(resolved, walletName, networkId, 'unshielded');
  await evictCachedState(resolved, walletName, networkId, 'dust');
  await evictCachedState(resolved, walletName, networkId, 'history');
}

/**
 * Remove every artifact a wallet leaves behind so re-creating a wallet under
 * the same name never silently inherits stale state from a previous seed:
 *   - the serialized sync state held in the SyncStateStore (the `.dat` entries;
 *     IndexedDB in the extension, the fs-backed store under the daemon/CLI/TUI),
 *     cleared via clearSyncCache so this works in the browser too; and
 *   - on node only, the per-wallet `~/.moth/sync/<network>/<name>/` directory
 *     and the matching daemon `.sock` file, which live outside the store.
 *
 * Best-effort: missing artifacts are ignored. The node-only fs work is behind a
 * dynamic import so this module keeps its "no static node:* imports" invariant
 * (see the file header) and stays browser-bundleable.
 */
export async function removeWalletSyncArtifacts(
  walletName: string,
  networkId: string,
  store?: SyncStateStore,
): Promise<void> {
  // Store-backed state — browser-safe, and on node this unlinks the .dat files.
  await clearSyncCache(walletName, networkId, store);

  // The daemon/CLI also leave a directory + socket on disk that the store
  // abstraction does not own. Skip entirely outside node (e.g. the extension).
  if (typeof process === 'undefined' || !process.versions?.node) return;
  try {
    const {rmSync, unlinkSync} = await import(/* @vite-ignore */ 'node:fs');
    const {join} = await import(/* @vite-ignore */ 'node:path');
    const {homedir} = await import(/* @vite-ignore */ 'node:os');
    const cacheBase = join(homedir(), '.moth', 'sync');
    try {
      rmSync(join(cacheBase, networkId, walletName), {recursive: true, force: true});
    } catch {
      /* directory absent or already gone */
    }
    try {
      unlinkSync(join(cacheBase, networkId, `${walletName}.sock`));
    } catch {
      /* socket absent or already cleaned by the daemon's shutdown */
    }
  } catch {
    /* node fs/path/os unavailable — nothing on disk to clean */
  }
}

/**
 * Clear ONLY the dust sub-wallet's cached state, keeping the (much larger)
 * shielded/unshielded caches. The next sync start rebuilds the dust view from
 * the chain — the targeted repair for a dust view that stopped ingesting
 * generation records for newer NIGHT UTXOs.
 */
export async function clearDustSyncCache(
  walletName: string,
  networkId: string,
  store?: SyncStateStore
): Promise<void> {
  const resolved = await resolveSyncStore(store);
  await evictCachedState(resolved, walletName, networkId, 'dust');
}
