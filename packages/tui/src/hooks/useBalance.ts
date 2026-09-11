import { useState, useEffect, useCallback, useRef } from 'react';
import {
  startWalletSync,
  formatNight,
  formatDustBalance,
  NIGHT_TOKEN_ID,
  resolveProverConfig,
  EMPTY_COINS,
  EMPTY_SUB_PROGRESS,
  type SyncedWallet,
  type NetworkConfig,
  type DustGeneration,
  type SyncProgress,
  type WalletBalances,
  type WalletCoinDetails,
  type SubWalletProgress,
  type WalletKeys,
} from '@shieldedtech/moth-wallet';

interface BalanceState {
  nightBalance: string;
  dustBalance: string;
  /** Raw DUST in SPECK (10^15 per DUST). */
  dustRaw: bigint;
  shieldedBalances: Record<string, bigint>;
  unshieldedBalances: Record<string, bigint>;
  synced: boolean;
  syncStatus: string;
  loading: boolean;
  dustGeneration: DustGeneration | null;
  syncProgress: SyncProgress | null;
  coins: WalletCoinDetails;
  subProgress: SubWalletProgress;
}

const EMPTY_STATE: BalanceState = {
  nightBalance: '0', dustBalance: '0', dustRaw: 0n,
  shieldedBalances: {}, unshieldedBalances: {},
  synced: false, syncStatus: '', loading: false,
  dustGeneration: null, syncProgress: null,
  coins: EMPTY_COINS, subProgress: EMPTY_SUB_PROGRESS,
};

// How many wallet sync engines are kept alive in the background at once,
// across switches. Each one holds an open indexer/node connection and keeps
// scanning, so this bounds the resource cost of "switching feels instant"
// against "N wallets syncing at all times". 3 covers the common case of
// flipping between a couple of wallets without unbounded growth.
const MAX_CACHED_FACADES = 3;

function facadeCacheKey(walletName: string, networkId: string): string {
  return `${walletName}::${networkId}`;
}

/**
 * Stop and drop cache entries beyond `MAX_CACHED_FACADES`, oldest first.
 * `Map` preserves insertion order, and callers re-insert an entry on every
 * reuse (see `startSync` below), so iteration order here already IS
 * least-recently-used order — no separate bookkeeping needed. `keepKey` is
 * the entry just inserted; it must survive even though it's newest, since a
 * caller reads this order before it becomes least-recent through use.
 */
function evictLru(cache: Map<string, SyncedWallet>, keepKey: string): void {
  for (const [key, synced] of cache) {
    if (cache.size <= MAX_CACHED_FACADES) break;
    if (key === keepKey) continue;
    cache.delete(key);
    synced.stop().catch(() => {});
  }
}

function balancesToState(b: WalletBalances, status?: string): BalanceState {
  const nightRaw = (b.unshielded[NIGHT_TOKEN_ID] ?? 0n) + (b.shielded[NIGHT_TOKEN_ID] ?? 0n);
  const nightStr = formatNight(nightRaw);
  return {
    nightBalance: nightStr,
    // DUST is SPECKS (10^15 per DUST); formatNight divides by 10^6 and would
    // render every balance a billion times too large.
    dustBalance: formatDustBalance(b.dust),
    dustRaw: b.dust,
    shieldedBalances: b.shielded,
    unshieldedBalances: b.unshielded,
    synced: b.synced,
    syncStatus: status ?? (b.synced ? `● synced` : `syncing — NIGHT: ${nightStr}`),
    loading: false,
    dustGeneration: b.dustGeneration,
    syncProgress: b.syncProgress,
    coins: b.coins,
    subProgress: b.subProgress,
  };
}

export function useBalance(
  walletKeys: WalletKeys | null,
  network: NetworkConfig | null,
  onLog?: (msg: string) => void,
  walletName?: string,
  isNewWallet?: boolean,
  /**
   * Birthday for the network being synced. Without it the pre-seed gate
   * (`isNewWallet || birthday`) leaves an existing wallet on the genesis path
   * however good a reference is in the store — silently, as a slow sync.
   */
  getBirthday?: (networkId: string) => Promise<number | undefined>,
) {
  const prover = network ? resolveProverConfig(network) : null;
  const proverKey = prover?.type === 'server' ? `server:${prover.url}` : (prover?.type ?? '');
  const [state, setState] = useState<BalanceState>(EMPTY_STATE);
  const syncRef = useRef<SyncedWallet | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  // Session-only cache of live sync engines, keyed by wallet+network, so
  // switching back to a wallet already touched this session reuses its
  // running facade instead of re-reading and re-deserializing its cache from
  // disk. A wallet's facade keeps syncing here even while another wallet is
  // the one on screen; `dropWallet` (below) is the escape hatch for when that
  // must stop — locking or removing the wallet, in particular, since a
  // background facade still holds the same secret-key objects `lock()`
  // zeroes, and letting it run past that point is exactly the
  // "secret key was cleared" crash this cache must not reintroduce.
  const facadeCache = useRef<Map<string, SyncedWallet>>(new Map());

  const startSync = useCallback(async () => {
    if (!walletKeys || !network || !walletName) {
      onLogRef.current?.(`[sync] not starting — ${!walletKeys ? 'no wallet keys (wallet locked?)' : 'no network'}`);
      setState(EMPTY_STATE);
      return;
    }

    // Detach from whatever facade this hook was watching. Note this does NOT
    // stop it: it may be the very facade we're about to resume below, and
    // even when it's a different one, it stays alive in `facadeCache` for a
    // possible future switch back — only `evictLru`/`dropWallet`/`stop` (all
    // below) actually terminate a cached facade.
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    syncRef.current = null;

    const key = facadeCacheKey(walletName, network.id);
    const cachedSynced = facadeCache.current.get(key);

    // Reset to empty (not `...prev`) so a wallet/network switch never shows the
    // PREVIOUS wallet's balances/coins/progress while the new wallet syncs.
    // startSync only re-runs when walletKeys / network / walletName change, so
    // this clears stale data exactly on a switch — not during normal operation.
    // (A cache hit below overwrites this again almost immediately, via
    // `subscribe`'s immediate replay of the resumed facade's last balances.)
    setState({ ...EMPTY_STATE, loading: true, syncStatus: cachedSynced ? 'Resuming session cache...' : 'Starting sync...' });

    try {
      let synced: SyncedWallet;
      if (cachedSynced) {
        onLogRef.current?.(`[sync] resuming cached facade — wallet=${walletName} network=${network.id}`);
        synced = cachedSynced;
        // Touch LRU order: re-insert so this key reads as most-recently-used.
        facadeCache.current.delete(key);
        facadeCache.current.set(key, synced);
      } else {
        onLogRef.current?.(`[sync] startWalletSync begin — wallet=${walletName} network=${network.id} indexer=${network.indexerUrl}`);
        synced = await startWalletSync(walletKeys, network, (msg) => {
          setState(prev => ({ ...prev, syncStatus: msg }));
        }, walletName, isNewWallet, await getBirthday?.(network.id));
        onLogRef.current?.('[sync] startWalletSync resolved — facade ready, subscribing');
        facadeCache.current.set(key, synced);
        evictLru(facadeCache.current, key);
      }

      syncRef.current = synced;

      let firstEmit = true;
      const unsub = synced.subscribe((balances) => {
        if (firstEmit) {
          firstEmit = false;
          onLogRef.current?.(`[sync] first balance emit — synced=${balances.synced} pct=${Math.round((balances.syncProgress?.percentage ?? 0) * 100)}%`);
        }
        setState(balancesToState(balances));
      });
      unsubRef.current = unsub;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState(prev => ({ ...prev, synced: false, syncStatus: `Sync failed: ${msg}`, loading: false }));
      onLogRef.current?.(`Sync failed: ${msg}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKeys, network?.id, network?.nodeUrl, network?.indexerUrl, proverKey, walletName, isNewWallet, getBirthday]);

  useEffect(() => {
    startSync();

    // Fallback poller
    const poller = setInterval(async () => {
      if (syncRef.current) {
        try {
          const b = await syncRef.current.refresh();
          setState(prev => {
            const next = balancesToState(b);
            if (prev.nightBalance === next.nightBalance && prev.dustBalance === next.dustBalance && prev.synced === next.synced) return prev;
            return next;
          });
        } catch { /* facade not ready yet */ }
      }
    }, 5_000);

    return () => {
      clearInterval(poller);
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      // Deliberately does not stop the facade — see the comment on
      // `facadeCache` above. It stays cached (subject to `evictLru`) for a
      // possible switch back.
      syncRef.current = null;
    };
  }, [startSync]);

  const refresh = useCallback(async () => {
    if (syncRef.current) {
      const b = await syncRef.current.refresh();
      setState(balancesToState(b));
    }
  }, []);

  const getFacade = useCallback(() => syncRef.current?.facade ?? null, []);

  /**
   * Stop and evict every cached facade for one wallet (all networks it may be
   * cached under), bounded the same way `stop()` below is.
   *
   * Must be awaited before that wallet's keys are zeroed: a facade kept alive
   * in `facadeCache` for a fast switch-back still holds the same secret-key
   * objects `lock()` clears, and a batch still in flight inside it would then
   * throw `Dust secret key was cleared` (see `stop()`'s doc comment) — the
   * exact bug this cache must not reintroduce for a wallet that isn't even
   * the one currently on screen. Call this from wherever a wallet is locked
   * or removed, whether or not it's the active one.
   */
  const dropWallet = useCallback(async (name: string, timeoutMs = 3_000): Promise<void> => {
    const dropped: SyncedWallet[] = [];
    const prefix = `${name}::`;
    for (const [key, synced] of facadeCache.current) {
      if (!key.startsWith(prefix)) continue;
      facadeCache.current.delete(key);
      dropped.push(synced);
    }
    if (dropped.length === 0) return;
    if (syncRef.current && dropped.includes(syncRef.current)) {
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      syncRef.current = null;
    }
    await Promise.race([
      Promise.all(dropped.map((s) => s.stop().catch(() => {}))),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }, []);

  /**
   * Stop syncing — every cached facade, not just the one on screen — and wait
   * for it, before anything frees any wallet's keys.
   *
   * Quitting called `lockAll()` and `exit()` immediately, which zeroed the dust
   * secret key in WASM while the dust sync was still mid-batch. The next
   * `replayEventsWithChanges` then threw `Dust secret key was cleared`, once per
   * live facade, over the top of the exiting terminal.
   *
   * Bounded, because quitting must not hang on a sync that will not settle: after
   * the deadline it gives up and lets the caller proceed. A key freed under a
   * still-running sync is noisy; a TUI that will not close is worse.
   */
  const stop = useCallback(async (timeoutMs = 3_000): Promise<void> => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    syncRef.current = null;
    const all = Array.from(facadeCache.current.values());
    facadeCache.current.clear();
    if (all.length === 0) return;
    await Promise.race([
      Promise.all(all.map((s) => s.stop().catch(() => {}))),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }, []);

  return { ...state, refresh, getFacade, stop, dropWallet };
}
