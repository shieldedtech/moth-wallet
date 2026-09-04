// React hooks used by the side panel and approval window. Thin clients over
// the background protocol — no wallet logic lives in UI surfaces.

import { useCallback, useEffect, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { WalletInfo, WalletBalances, TxStage, ActivityEntry } from '@shieldedtech/moth-browser';
import type { ProverType } from './proving-method';
import {
  sendMessage,
  deserializeBalances,
  BALANCES_PORT,
  type SessionStatus,
  type PortEvent,
  type RelayState,
} from '../messaging/protocol';
import { deserializeActivity } from '../messaging/activity-json';
import type { AddressBookEntry } from '../background/address-book';
import type { AddressKind } from './address';
import { hasUnregisteredNightToNudge } from './dust-nudge';

/** Fired on the window when the background reports an out-of-band lock, so the
 *  session hook re-reads status without the shell having to wire the two hooks
 *  together. Dispatched by usePanelEvents; consumed by useSession. */
const SESSION_LOCKED_EVENT = 'moth:sessionLocked';

export function useSession() {
  const [status, setStatus] = useState<SessionStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await sendMessage('sessionStatus', undefined));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-lock happens in the background; pick up the now-locked status.
  useEffect(() => {
    const onLocked = () => void refresh();
    window.addEventListener(SESSION_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(SESSION_LOCKED_EVENT, onLocked);
  }, [refresh]);

  const unlock = useCallback(
    async (name: string, passphrase: string) => {
      const next = await sendMessage('sessionUnlock', { name, passphrase });
      setStatus(next);
      return next;
    },
    [],
  );

  const lock = useCallback(async () => {
    await sendMessage('sessionLock', undefined);
    await refresh();
  }, [refresh]);

  return { status, refresh, unlock, lock };
}

export function useWallets() {
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);

  const refresh = useCallback(async () => {
    setWallets(await sendMessage('walletList', undefined));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Optimistically flip the active flag — account switching must not wait
   *  for a walletList round-trip (the offscreen document answers slowly while
   *  sync is applying WASM batches). Reconcile with refresh() afterwards. */
  const markActive = useCallback((name: string) => {
    setWallets((prev) => prev?.map((wallet) => ({ ...wallet, active: wallet.name === name })) ?? prev);
  }, []);

  return { wallets, refresh, markActive };
}

/** The proving method resolved from the active network configuration. */
/**
 * Whether developer mode is on. Read once per mount: it is a setting the user
 * changes deliberately on another screen, and the panel remounts on navigation,
 * so watching it would buy nothing. Defaults to off if the read fails — the
 * quieter of the two wrong answers.
 */
export function useDeveloperMode(): boolean {
  const [developerMode, setDeveloperMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void sendMessage('settingsGet', undefined)
      .then((settings) => {
        if (!cancelled) setDeveloperMode(settings.developerMode);
      })
      .catch(() => {
        /* background not up — off is the safe default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return developerMode;
}

/**
 * True exactly once per mount, the first time this wallet shows unregistered
 * NIGHT, fully synced — see dust-nudge.ts. Latched (never resets to false)
 * so a caller driving a one-shot toast off it does not need its own guard.
 */
export function useRegisterNudge(balances: WalletBalances | null): boolean {
  const [due, setDue] = useState(false);

  useEffect(() => {
    if (!due && hasUnregisteredNightToNudge(balances)) setDue(true);
  }, [balances, due]);

  return due;
}

export function useSelectedProverType(network: string | undefined) {
  const [proverType, setProverType] = useState<ProverType | null>(null);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    if (!network) {
      setProverType(null);
      return;
    }

    try {
      const config = await sendMessage('networkConfigGet', undefined);
      if (request === latestRequest.current && config.id === network) {
        setProverType(config.prover.type);
      }
    } catch {
      if (request === latestRequest.current) setProverType(null);
    }
  }, [network]);

  useEffect(() => {
    setProverType(null);
    void refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);

  return { proverType, refresh };
}

/**
 * User-assigned token display names (tokenId → name). `rename` persists a new
 * name (empty clears it) and applies the background's updated map locally.
 */
export function useTokenNames() {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    sendMessage('tokenNamesGet', undefined)
      .then((map) => {
        if (!cancelled) setNames(map);
      })
      .catch(() => {
        /* transient — token ids still render */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rename = useCallback(async (tokenId: string, name: string) => {
    setNames(await sendMessage('tokenNameSet', { tokenId, name }));
  }, []);

  return { names, rename };
}

/**
 * The saved address book. `save` upserts (new entry without id, edit with id)
 * and `remove` deletes; both apply the background's updated list locally.
 */
export function useAddressBook() {
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    sendMessage('addressBookGet', undefined)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        /* transient — manual entry still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (entry: { id?: string; name: string; address: string; kind: AddressKind }) => {
      setEntries(await sendMessage('addressBookSave', entry));
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    setEntries(await sendMessage('addressBookRemove', { id }));
  }, []);

  return { entries, save, remove };
}

/**
 * The activity feed for the unlocked account. Refetches when a sub-wallet
 * applies new transactions (the applied indices are a cheap change signal that
 * avoids a round-trip per balance emission at steady state) — that's also what
 * flips a pending row to applied. `null` until the first response.
 */
export function useActivity(balances: WalletBalances | null): ActivityEntry[] | null {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const applied = balances
    ? `${balances.subProgress.shielded.applied}/${balances.subProgress.unshielded.applied}/${balances.subProgress.dust.applied}`
    : '';

  useEffect(() => {
    let cancelled = false;
    sendMessage('activityGet', undefined)
      .then((payload) => {
        if (!cancelled) setEntries(deserializeActivity(payload));
      })
      .catch(() => {
        /* locked or transient — keep whatever we had */
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  return entries;
}

export interface PanelEvents {
  balances: WalletBalances | null;
  syncMessage: string;
  txStage: TxStage | null;
  /** id of a dApp approval awaiting a decision, or null */
  approvalId: string | null;
  /** A setup tab is creating/importing an account right now. */
  setupOpen: boolean;
  /** Node-relay reachability, or null before the first report. Independent of
   *  sync: the relay backs transaction submission, so it can be down while
   *  balances stream in perfectly well. */
  relayState: RelayState | null;
  /** Drop cached balances/sync state — call on lock so the next account never
   *  renders the previous account's numbers. Keeps any pending approval. */
  reset: () => void;
}

/**
 * Opens the panel's event port (which also tells the background to run sync
 * while a session exists) and renders the cached snapshot immediately while
 * live updates stream in. Also carries pending dApp approval notifications,
 * which arrive even while locked.
 */
export function usePanelEvents(): PanelEvents {
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [syncMessage, setSyncMessage] = useState('');
  const [txStage, setTxStage] = useState<TxStage | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [relayState, setRelayState] = useState<RelayState | null>(null);
  // The stream re-emits identical balances (e.g. steady state after sync);
  // skip the JSON.parse + re-render when the raw payload hasn't changed. A ref
  // (not an effect-local) so reset() can clear it.
  const lastBalances = useRef('');

  useEffect(() => {
    let cancelled = false;
    let port: Browser.runtime.Port | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const applyBalances = (data: string) => {
      if (data === lastBalances.current) return;
      lastBalances.current = data;
      setBalances(deserializeBalances(data));
    };

    // Chrome terminates the MV3 service worker whenever sync goes >30s without
    // an event (quiet chain at tip, indexer reconnect, machine sleep), and that
    // severs this port even though the offscreen worker is still syncing. The
    // port is also what tells the background to run sync at all — so on remote
    // disconnect, reconnect (which revives the SW) instead of going dark, and
    // re-fetch the cached snapshot to cover updates broadcast while detached.
    const connect = () => {
      if (cancelled) return;
      // Guards: a live port event is fresher than the fetched snapshot /
      // pending-approval answer, so a slower response must not overwrite it.
      let liveBalances = false;
      let liveApproval = false;
      void sendMessage('balancesSnapshot', undefined).then((snapshot) => {
        if (!cancelled && snapshot && !liveBalances) applyBalances(snapshot);
      });
      // Unconditional set: after a SW restart a pending approval's resolver is
      // gone, and this is what unsticks a panel left on the approval screen.
      void sendMessage('approvalPending', undefined).then(({ approval }) => {
        if (!cancelled && !liveApproval) setApprovalId(approval?.id ?? null);
      });

      try {
        port = browser.runtime.connect({ name: BALANCES_PORT });
      } catch {
        return; // extension context invalidated — this page is going away
      }
      port.onMessage.addListener((raw) => {
        const event = raw as PortEvent;
        if (event.kind === 'balances') {
          liveBalances = true;
          applyBalances(event.data);
        } else if (event.kind === 'syncMessage') setSyncMessage(event.message);
        else if (event.kind === 'syncReset') {
          liveBalances = true;
          lastBalances.current = '';
          setBalances(null);
          setSyncMessage('');
          setTxStage(null);
        } else if (event.kind === 'txStage') setTxStage(event.stage);
        else if (event.kind === 'relayState') setRelayState(event.state);
        else if (event.kind === 'approval') {
          liveApproval = true;
          setApprovalId(event.id);
        } else if (event.kind === 'setupOpen') setSetupOpen(event.open);
        else if (event.kind === 'sessionLocked') window.dispatchEvent(new Event(SESSION_LOCKED_EVENT));
      });
      // Fires only when the other end dies (SW terminated, extension reload) —
      // our own disconnect() in the cleanup below doesn't raise it locally.
      port.onDisconnect.addListener(() => {
        port = null;
        if (!cancelled) retry = setTimeout(connect, 500);
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (retry !== null) clearTimeout(retry);
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    };
  }, []);

  // Report activity so the background can reset the inactivity timer: once on
  // mount (opening the panel is activity) and on throttled pointer/key input.
  // Throttled hard — a ping only needs to land occasionally within the window.
  useEffect(() => {
    let last = 0;
    const ping = () => {
      const now = Date.now();
      if (now - last < 20_000) return;
      last = now;
      void sendMessage('activityPing', undefined).catch(() => {});
    };
    ping();
    window.addEventListener('pointerdown', ping);
    window.addEventListener('keydown', ping);
    return () => {
      window.removeEventListener('pointerdown', ping);
      window.removeEventListener('keydown', ping);
    };
  }, []);

  const reset = useCallback(() => {
    lastBalances.current = '';
    setBalances(null);
    setSyncMessage('');
    setTxStage(null);
  }, []);

  // relayState is deliberately NOT cleared by reset(): it describes the node
  // endpoint, not the account, and survives a lock or an account switch exactly
  // as the outage itself does.
  return { balances, syncMessage, txStage, approvalId, setupOpen, relayState, reset };
}
