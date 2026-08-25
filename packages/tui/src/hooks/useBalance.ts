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

  const startSync = useCallback(async () => {
    if (!walletKeys || !network) {
      onLogRef.current?.(`[sync] not starting — ${!walletKeys ? 'no wallet keys (wallet locked?)' : 'no network'}`);
      setState(EMPTY_STATE);
      return;
    }

    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    if (syncRef.current) { await syncRef.current.stop(); syncRef.current = null; }

    // Reset to empty (not `...prev`) so a wallet/network switch never shows the
    // PREVIOUS wallet's balances/coins/progress while the new wallet syncs.
    // startSync only re-runs when walletKeys / network / walletName change, so
    // this clears stale data exactly on a switch — not during normal operation.
    setState({ ...EMPTY_STATE, loading: true, syncStatus: 'Starting sync...' });

    try {
      onLogRef.current?.(`[sync] startWalletSync begin — wallet=${walletName ?? '?'} network=${network.id} indexer=${network.indexerUrl}`);
      const synced = await startWalletSync(walletKeys, network, (msg) => {
        setState(prev => ({ ...prev, syncStatus: msg }));
      }, walletName, isNewWallet, await getBirthday?.(network.id));
      onLogRef.current?.('[sync] startWalletSync resolved — facade ready, subscribing');

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
      if (syncRef.current) { syncRef.current.stop().catch(() => {}); syncRef.current = null; }
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
   * Quitting used to call `lockAll()` and `exit()` immediately, which zeroed the
   * dust secret key in WASM while the dust sync was still mid-batch. The next
   * `replayEventsWithChanges` then threw `Dust secret key was cleared`, once per
   * live facade, over the top of the exiting terminal.
   *
   * Bounded, because quitting must not hang on a sync that will not settle: after
   * the deadline it gives up and lets the caller proceed. A key freed under a
   * still-running sync is noisy; a TUI that will not close is worse.
   */
  const stop = useCallback(async (timeoutMs = 3_000): Promise<void> => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    const synced = syncRef.current;
    syncRef.current = null;
    if (!synced) return;
    await Promise.race([
      synced.stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }, []);

  return { ...state, refresh, getFacade, stop };
}
