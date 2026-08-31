import { useState, useEffect, useCallback, useRef } from 'react';
import {
  startWalletSync,
  formatNight,
  formatDustBalance,
  NIGHT_TOKEN_ID,
  resolveProverConfig,
  EMPTY_COINS,
  EMPTY_SUB_PROGRESS,
  warmPoolKey,
  applyNetworkId,
  type WarmSyncPool,
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
  /**
   * Optional pool of live facades. When present, a switch parks the outgoing
   * sync instead of stopping it, and a switch back reuses it — see WarmSyncPool
   * for the cost and the eviction obligations that come with it.
   */
  warmPool?: WarmSyncPool | null,
) {
  const prover = network ? resolveProverConfig(network) : null;
  const proverKey = prover?.type === 'server' ? `server:${prover.url}` : (prover?.type ?? '');
  const [state, setState] = useState<BalanceState>(EMPTY_STATE);
  const syncRef = useRef<SyncedWallet | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  /** Identity of whatever syncRef holds, so it can be parked under the key it was built with. */
  const syncKeyRef = useRef<{ key: string; walletName: string; networkId: string } | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const poolRef = useRef(warmPool);
  poolRef.current = warmPool;

  /**
   * Release the running sync: park it if a pool is taking it, stop it otherwise.
   *
   * The stop is NOT awaited when the incoming sync is for a different
   * (wallet, network) — those write disjoint cache entries, so nothing the
   * outgoing teardown does can be seen by the incoming restore, and awaiting it
   * only puts the SDK's bounded-at-5s teardown on the critical path of a switch.
   * A restart of the SAME wallet does overlap, and is awaited.
   *
   * `park: false` is for the case where there is nothing to come back to. Losing
   * the keys is one of those: the hook re-runs with `walletKeys === null` the
   * moment a wallet is locked, and parking there would hand the pool a facade
   * whose keys have just been zeroed — precisely what every eviction call site
   * exists to prevent.
   */
  const release = useCallback(async (
    incoming: { walletName: string; networkId: string } | null,
    { park = true }: { park?: boolean } = {},
  ) => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    const outgoing = syncRef.current;
    const outgoingKey = syncKeyRef.current;
    syncRef.current = null;
    syncKeyRef.current = null;
    if (!outgoing) return;

    const pool = park ? poolRef.current : null;
    if (pool && outgoingKey) {
      pool.park(outgoingKey.key, outgoing, outgoingKey.walletName, outgoingKey.networkId);
      return;
    }
    const overlaps =
      incoming !== null &&
      outgoingKey !== null &&
      incoming.walletName === outgoingKey.walletName &&
      incoming.networkId === outgoingKey.networkId;
    if (overlaps) {
      await outgoing.stop().catch(() => {});
    } else {
      void outgoing.stop().catch(() => {});
    }
  }, []);

  const startSync = useCallback(async () => {
    if (!walletKeys || !network) {
      onLogRef.current?.(`[sync] not starting — ${!walletKeys ? 'no wallet keys (wallet locked?)' : 'no network'}`);
      await release(null, { park: false });
      setState(EMPTY_STATE);
      return;
    }

    const name = walletName ?? 'default';
    const key = warmPoolKey(name, network, proverKey);
    await release({ walletName: name, networkId: network.id });

    // Reset to empty (not `...prev`) so a wallet/network switch never shows the
    // PREVIOUS wallet's balances/coins/progress while the new wallet syncs.
    // startSync only re-runs when walletKeys / network / walletName change, so
    // this clears stale data exactly on a switch — not during normal operation.
    setState({ ...EMPTY_STATE, loading: true, syncStatus: 'Starting sync...' });

    try {
      // A warm facade is already synced and still streaming: take it and
      // subscribe. This is the entire point of the pool — no cache restore, no
      // facade init, no reconnect, no wait for a first emission.
      const warm = poolRef.current?.take(key);
      // The cold path sets the SDK's global network id inside startWalletSync;
      // reusing a facade skips it, and the session may have visited another
      // network in between. See applyNetworkId.
      if (warm) applyNetworkId(network.id);
      const synced = warm ?? await (async () => {
        onLogRef.current?.(`[sync] startWalletSync begin — wallet=${name} network=${network.id} indexer=${network.indexerUrl}`);
        const started = await startWalletSync(walletKeys, network, (msg) => {
          setState(prev => ({ ...prev, syncStatus: msg }));
        }, walletName, isNewWallet, await getBirthday?.(network.id));
        onLogRef.current?.('[sync] startWalletSync resolved — facade ready, subscribing');
        return started;
      })();
      if (warm) onLogRef.current?.(`[sync] reusing warm facade — wallet=${name} network=${network.id}`);

      syncRef.current = synced;
      syncKeyRef.current = { key, walletName: name, networkId: network.id };

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
  }, [walletKeys, network?.id, network?.nodeUrl, network?.indexerUrl, proverKey, walletName, isNewWallet, getBirthday, release]);

  // Final teardown, on unmount only. The [startSync] effect below cannot do this:
  // its cleanup also runs between two syncs, and stopping there would destroy
  // the facade the next startSync means to park or reuse. Transitions are
  // `release`'s job; this is the last one out.
  useEffect(() => () => {
    const synced = syncRef.current;
    syncRef.current = null;
    syncKeyRef.current = null;
    if (synced) void synced.stop().catch(() => {});
  }, []);

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
      // Unsubscribe only — the running sync is left in place for `release` (or,
      // on unmount, for the effect above) to park, reuse, or stop.
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
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
   * Stop syncing and wait for it, before anything frees the keys.
   *
   * Quitting called `lockAll()` and `exit()` immediately, which zeroed the dust
   * secret key in WASM while the dust sync was still mid-batch. The next
   * `replayEventsWithChanges` then threw `Dust secret key was cleared`, once per
   * live facade, over the top of the exiting terminal.
   *
   * Bounded, because quitting must not hang on a sync that will not settle: after
   * the deadline it gives up and lets the caller proceed. A key freed under a
   * still-running sync is noisy; a TUI that will not close is worse.
   *
   * Stops rather than parks, whatever the pool holds: this is the path to freeing
   * key material, and a parked facade would go on syncing with keys about to be
   * zeroed. Callers must drain the pool itself alongside this (see WarmSyncPool).
   */
  const stop = useCallback(async (timeoutMs = 3_000): Promise<void> => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    const synced = syncRef.current;
    syncRef.current = null;
    syncKeyRef.current = null;
    if (!synced) return;
    await Promise.race([
      synced.stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }, []);

  return { ...state, refresh, getFacade, stop };
}
