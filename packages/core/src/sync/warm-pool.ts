// A pool of live WalletFacades, parked rather than stopped, so switching back
// to a wallet costs a re-subscribe instead of a full teardown and rebuild.
//
// Everything under sync/ is keyed per (wallet, network) — the cache entries
// (see syncStateKey), the WASM sub-wallet state, the indexer subscription — so
// two wallets on the SAME network share nothing, and every switch pays for a
// complete rebuild: serialize four caches, stop the SDK (bounded at
// STOP_TIMEOUT_MS against a node whose client never settles), deserialize three
// sub-wallets, re-init the facade, reconnect, then wait up to 5s for a first
// state emission. Parking the outgoing facade skips all of it on the way back.
//
// OFF by default (capacity 0), and deliberately. A parked facade holds its
// wallet's full WASM state resident AND keeps its indexer subscription open, so
// each warm entry costs roughly the memory and network of a second wallet that
// is still syncing. Callers opt in with a capacity they are willing to pay for;
// at 0 this class is a pass-through that stops what it is handed, which is what
// the code did before it existed.
//
// SAFETY — a parked facade holds LIVE secret keys in WASM and keeps syncing
// with them:
//   - Anything that frees key material (lockOne, lockAll, quitting) MUST evict
//     the matching entries first, or the next dust batch throws `Dust secret key
//     was cleared` from a facade nothing is watching — the same failure the
//     quit path already guards against for the foreground sync.
//   - Anything that clears a wallet's stored sync state MUST evict too. A parked
//     facade rewrites those entries on its next save, so a clear that skips the
//     pool silently does nothing.

import type {SyncedWallet} from './wallet-sync.js';

/** How long a caller will wait for parked facades to stop before proceeding. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

interface PoolEntry {
  wallet: SyncedWallet;
  walletName: string;
  networkId: string;
}

/**
 * Identity of a warm entry.
 *
 * The endpoints belong in the key, not just the wallet and network: a facade is
 * built against specific indexer/node/prover endpoints, so reusing one after the
 * user edits a network override would keep talking to the old ones — a switch
 * that silently ignores the setting it was made to apply. Keying on them turns
 * that into an ordinary cache miss.
 */
export function warmPoolKey(
  walletName: string,
  network: {id: string; nodeUrl: string; indexerUrl: string},
  proverKey = '',
): string {
  return JSON.stringify([walletName, network.id, network.nodeUrl, network.indexerUrl, proverKey]);
}

export class WarmSyncPool {
  private capacityValue: number;
  /** Insertion-ordered, least-recently parked first — `park` re-inserts to refresh recency. */
  private readonly entries = new Map<string, PoolEntry>();
  /** In-flight stops, so a drain can wait for teardowns it did not start. */
  private readonly draining = new Set<Promise<void>>();

  constructor(capacity = 0) {
    this.capacityValue = Math.max(0, capacity);
  }

  get size(): number {
    return this.entries.size;
  }

  get capacity(): number {
    return this.capacityValue;
  }

  /** Change how many facades stay warm. Lowering it stops the excess immediately. */
  setCapacity(capacity: number): void {
    this.capacityValue = Math.max(0, capacity);
    this.trim();
  }

  /**
   * Take ownership of a warm facade, if one is parked under this key.
   *
   * Removes it from the pool: the caller owns it from here, and is responsible
   * for parking or stopping it again. Two owners of one facade would each
   * subscribe and each stop it, so the pool never hands out a reference it keeps.
   */
  take(key: string): SyncedWallet | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    return entry.wallet;
  }

  /**
   * Hand a facade back to the pool, still running.
   *
   * At capacity 0 this stops it instead — the caller's code path is the same
   * whether the pool is enabled or not.
   */
  park(key: string, wallet: SyncedWallet, walletName: string, networkId: string): void {
    if (this.capacityValue <= 0) {
      this.stopDetached(wallet);
      return;
    }
    const existing = this.entries.get(key);
    if (existing && existing.wallet !== wallet) this.stopDetached(existing.wallet);
    // Delete before set so the re-inserted entry lands at the end of the
    // iteration order: Map preserves insertion order, which is the whole LRU.
    this.entries.delete(key);
    this.entries.set(key, {wallet, walletName, networkId});
    this.trim();
  }

  /** Stop and drop everything parked for a wallet — every network unless one is named. */
  async evictWallet(walletName: string, networkId?: string, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.walletName !== walletName) continue;
      if (networkId !== undefined && entry.networkId !== networkId) continue;
      this.entries.delete(key);
      this.stopDetached(entry.wallet);
    }
    await this.drain(timeoutMs);
  }

  /** Stop and drop every warm facade, then wait (bounded) for the teardowns. */
  async evictAll(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      this.entries.delete(key);
      this.stopDetached(entry.wallet);
    }
    await this.drain(timeoutMs);
  }

  /**
   * Wait for in-flight teardowns, bounded.
   *
   * Bounded because callers drain on the way to freeing keys or exiting, and
   * `stop()` is only bounded in its SDK half — its cache save is not. The same
   * trade the foreground stop already makes: a key freed under a still-running
   * sync is noisy, a session that will not close is worse.
   */
  async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.draining.size === 0) return;
    const pending = Promise.all([...this.draining]).then(() => undefined);
    if (timeoutMs <= 0) {
      await pending;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  private trim(): void {
    while (this.entries.size > this.capacityValue) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const entry = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.stopDetached(entry.wallet);
    }
  }

  private stopDetached(wallet: SyncedWallet): void {
    const promise = wallet
      .stop()
      .catch(() => {})
      .finally(() => {
        this.draining.delete(promise);
      });
    this.draining.add(promise);
  }
}
