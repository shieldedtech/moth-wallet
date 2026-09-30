// React hook that owns the lifecycle of the wallet daemon socket while
// the TUI is running. Binds when (network, wallet) is ready, rebinds on
// change, and tears down on unmount.
//
// L1 perms are enforced server-side by startDaemon (0700 dir, 0600 socket).
// L3 (per-op confirmation) flows through a ConfirmationQueue: handlers
// for write operations call queue.request() and either complete the op
// or reject with UNAUTHORIZED depending on the user's answer in the TUI.
//
// The actual handler bodies live in core (buildWalletHandlers); this
// hook just wires React state into the dependency bundle and starts /
// stops the socket.

import {useEffect, useMemo, useRef, useState} from 'react';
import {
  startDaemon,
  daemonSocketPath,
  buildWalletHandlers,
  AuditLog,
  type DaemonHandle,
  type NetworkConfig,
  type WalletBalances,
  type WalletKeys,
  type ConfirmationQueue,
} from '@shieldedtech/moth-wallet';
import type {CardanoNetworkConfig} from '@shieldedtech/moth-wallet/cardano/network';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';

export interface UseDaemonHostOptions {
  readonly network: NetworkConfig | null;
  readonly walletName: string | undefined;
  /** Ref to the latest WalletBalances snapshot. Read at handler-call
   *  time so getState always reflects current state. */
  readonly balancesRef: React.MutableRefObject<WalletBalances | null>;
  /** Getter for the live WalletFacade. Returns null when no wallet is
   *  unlocked or sync hasn't initialized yet — write verbs reject in
   *  that case. */
  readonly getFacade: () => WalletFacade | null;
  /** Getter for the active wallet's typed key bundle (D-KM-3). */
  readonly getWalletKeys: () => WalletKeys | null;
  readonly queue: ConfirmationQueue;
  /**
   * Cardano capability for the cNIGHT verbs. Omitted until the config has
   * loaded; the verbs stay in the method table either way and refuse with a
   * reason, which a client can tell apart from an old daemon that has never
   * heard of them.
   */
  readonly cardano?: {
    readonly config: CardanoNetworkConfig;
    readonly getMnemonic: () => string | null;
    readonly getDustAddress: () => string;
  };
  readonly daemonVersion: string;
  readonly logs?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export type UseDaemonHostStatus = 'idle' | 'starting' | 'listening' | 'failed';

export interface UseDaemonHostState {
  readonly status: UseDaemonHostStatus;
  readonly socketPath: string | null;
  readonly lastError: string | null;
}

export function useDaemonHost(opts: UseDaemonHostOptions): UseDaemonHostState {
  const {network, walletName, balancesRef, getFacade, getWalletKeys, queue, cardano, daemonVersion, logs} = opts;
  const getFacadeRef = useRef(getFacade);
  getFacadeRef.current = getFacade;
  const getWalletKeysRef = useRef(getWalletKeys);
  getWalletKeysRef.current = getWalletKeys;
  // Read through a ref for the same reason as the facade: handlers run outside
  // the render tree, and the wallet can be locked and unlocked under a bound
  // socket without the daemon rebinding.
  const cardanoRef = useRef(cardano);
  cardanoRef.current = cardano;
  const logsRef = useRef(logs);
  logsRef.current = logs;

  // One AuditLog instance per host lifetime — its constructor mkdir's
  // ~/.moth/ and stat-checks rotation on each write, so creating it
  // is cheap. Memoize so the same sink threads through every handler
  // dependency bundle even across React rerenders.
  const auditLog = useMemo(() => new AuditLog(), []);

  const [state, setState] = useState<UseDaemonHostState>({
    status: 'idle',
    socketPath: null,
    lastError: null,
  });

  useEffect(() => {
    if (!network || !walletName) {
      // Bail to the same reference when already idle — an unconditional
      // fresh object here turns any unstable `network` identity into an
      // infinite render loop (effect → setState → render → effect).
      setState(prev =>
        prev.status === 'idle' && prev.socketPath === null && prev.lastError === null
          ? prev
          : {status: 'idle', socketPath: null, lastError: null},
      );
      return;
    }

    let handle: DaemonHandle | null = null;
    let cancelled = false;
    const socketPath = daemonSocketPath(network.id, walletName);
    setState({status: 'starting', socketPath, lastError: null});
    auditLog.recordLifecycle({
      wallet: walletName,
      network: network.id,
      event: 'daemon-start',
      message: `tui-host PID ${process.pid}`,
    });

    const handlers = buildWalletHandlers({
      walletName,
      network,
      getFacade: () => getFacadeRef.current(),
      getWalletKeys: () => getWalletKeysRef.current(),
      getBalances: () => balancesRef.current,
      queue,
      ...(cardano
        ? {
            cardano: {
              config: cardano.config,
              getMnemonic: () => cardanoRef.current?.getMnemonic() ?? null,
              getDustAddress: () => cardanoRef.current?.getDustAddress() ?? '',
            },
          }
        : {}),
      auditLog,
      log: (level, msg) => {
        if (level === 'info') logsRef.current?.info?.(msg);
        else if (level === 'warn') logsRef.current?.warn?.(msg);
        else logsRef.current?.error?.(msg);
      },
    });

    void (async () => {
      try {
        const h = await startDaemon({
          socketPath,
          daemonVersion,
          handlers,
          onLog: (level, msg) => logsRef.current?.[level]?.(`[daemon] ${msg}`),
        });
        if (cancelled) {
          await h.close();
          return;
        }
        handle = h;
        setState({status: 'listening', socketPath, lastError: null});
        logsRef.current?.info?.(`Daemon listening at ${socketPath}`);
        auditLog.recordLifecycle({
          wallet: walletName,
          network: network.id,
          event: 'socket-bound',
          message: socketPath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setState({status: 'failed', socketPath, lastError: message});
        }
        logsRef.current?.warn?.(`Daemon failed to start: ${message}`);
      }
    })();

    return () => {
      cancelled = true;
      const h = handle;
      handle = null;
      // Deny any pending confirmations so handlers waiting on the
      // queue don't hang indefinitely while we tear down.
      queue.drainAsDenied();
      if (h) {
        h.close().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logsRef.current?.warn?.(`Daemon shutdown error: ${msg}`);
        });
      }
      auditLog.recordLifecycle({
        wallet: walletName,
        network: network.id,
        event: 'daemon-stop',
      });
    };
  // `cardano?.config.network` and not the object: the config loads async, so
  // the first render has none and the socket must rebind once it arrives.
  // Keying on the object identity instead would rebind on every render.
  }, [network?.id, walletName, queue, daemonVersion, balancesRef, auditLog, network, cardano?.config.network]);

  return state;
}
