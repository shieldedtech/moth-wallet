// Offscreen document entry: a thin launcher/relay. It answers the SW's
// readiness ping synchronously and forwards every os/* method to the wallet
// host — which in production runs in a dedicated Web Worker (see
// ../../lib/offscreen/worker-bridge.ts and wallet-worker.ts) and under
// `wxt dev` runs inline on this thread. Host events (balances / sync / tx
// stage) flow back out through the bridge over the unchanged os/event* wire.

import { offscreenOn } from '../../lib/offscreen/messaging';
import { HOST_METHODS } from '../../lib/offscreen/host-dispatch';
import { hostRequest } from '../../lib/offscreen/worker-bridge';

// Synchronous — this is the readiness probe offscreen-client waits on, so it
// must never spawn the worker or touch WASM.
offscreenOn('os/ping', () => true);

// Forward each host method to the worker (prod) / inline host (dev). hostRequest
// rejects with the reconstructed host error, so @webext-core serializes exactly
// the failure the SW/UI saw before this indirection was added.
for (const method of HOST_METHODS) {
  offscreenOn(method, ({ data }) => hostRequest(method, data as never) as never);
}
