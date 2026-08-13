// The dedicated worker ("moth-wallet-host"): this is where the wallet SDK +
// ledger WASM actually run in production, off the offscreen document's renderer
// main thread so full-speed sync never blocks the panel.
//
// The message handler is registered synchronously during module evaluation, so
// requests the browser delivers before evaluation finishes are queued and drain
// once it exists — no ready handshake needed. The heavy host (WASM) is
// lazy-imported on the first request, keeping worker startup instant.

import { hostDispatch } from './host-dispatch';
import { installRelayBackoff, onRelayState } from './relay-socket';
import { requestMeter, installRequestMeter } from './request-meter';
import { serializeHostError, type WorkerRequest, type WorkerToPage } from './worker-rpc';

// Before ANY SDK code can capture globalThis.WebSocket. The host (and with it
// the wallet SDK, and with it @polkadot/rpc-provider) is lazy-imported below, so
// module scope here is the last point at which the swap is still invisible to it.
installRelayBackoff();

// Count every request this context makes, for the same reason and at the same
// point: the SDK captures the globals on first use, so the wrappers have to be
// in place before it is imported. Counting is a push onto an array against a
// network round trip, so it stays on rather than being something to remember to
// enable when a problem is already happening.
installRequestMeter(requestMeter);

// The project TS lib types `self` as a Window; narrow to just the worker-global
// surface we use so postMessage/onmessage type against the worker signatures.
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerToPage): void;
}
const workerScope = self as unknown as WorkerScope;

// Relay reachability rides the same worker → page → SW event channel as balances
// and sync messages. Wired here rather than in wallet-host because the backoff
// wrapper is installed before the host exists.
onRelayState((state) => workerScope.postMessage({ event: 'os/eventRelayState', data: state }));

type Host = typeof import('./wallet-host');
let hostPromise: Promise<Host> | null = null;
const host = (): Promise<Host> =>
  (hostPromise ??= import('./wallet-host').then((mod) => {
    // event/data are correlated by HostEmit's generic, but TS can't prove the
    // pair forms one WorkerEventMessage member across the union — assert it.
    mod.setHostEmit((event, data) => workerScope.postMessage({ event, data } as WorkerToPage));
    return mod;
  }));

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, method, data } = event.data;
  void (async () => {
    try {
      const result = await hostDispatch[method](await host(), data as never);
      workerScope.postMessage({ id, ok: true, result });
    } catch (err) {
      workerScope.postMessage({ id, ok: false, error: serializeHostError(err) });
    }
  })();
};
