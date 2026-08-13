// Offscreen-page side of the worker RPC. Lazily spawns the dedicated worker,
// correlates requests to responses by id, relays host events out over the
// offscreen → SW channel, and falls back to running the host inline under
// `wxt dev` (where a real cross-origin Worker can't load).

import { offscreenSend } from './messaging';
import { hostDispatch } from './host-dispatch';
import {
  deserializeHostError,
  type HostEvent,
  type HostEventData,
  type HostMethod,
  type MethodData,
  type MethodResult,
  type WorkerRequest,
  type WorkerToPage,
} from './worker-rpc';
// Vite's `?worker` import (NOT `new Worker(new URL('./x', import.meta.url))`):
// WXT injects `define: { 'import.meta.url': 'self.location.href' }`, and Vite's
// define plugin runs before worker-URL analysis, so the URL idiom silently emits
// no worker chunk. The `?worker` placeholder mechanism is immune.
import WalletWorker from './wallet-worker?worker';

// Relay a host event out over the offscreen → SW channel (wire protocol
// unchanged). Fire-and-forget: a torn-down SW channel is not this layer's
// concern.
function relayEvent<E extends HostEvent>(event: E, data: HostEventData[E]): void {
  void offscreenSend(event, data as never).catch(() => {});
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 1;
// Set once the worker posts its first message — proof it evaluated and
// registered onmessage. Distinguishes a load failure from a stray post-boot
// throw. Reset whenever the worker is dropped.
let booted = false;
const pending = new Map<number, Pending>();

// Reject every in-flight request and drop the worker so the next request
// respawns it (loud failure — never a silent slow fallback).
function failAll(error: Error): void {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
  worker?.terminate();
  worker = null;
  booted = false;
}

function spawn(): Worker {
  booted = false;
  const w = new WalletWorker({ name: 'moth-wallet-host' });
  w.onmessage = (event: MessageEvent<WorkerToPage>) => {
    booted = true;
    const message = event.data;
    if ('event' in message) {
      relayEvent(message.event, message.data);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(deserializeHostError(message.error));
  };
  w.onerror = (event) => {
    // Before the first message = a load failure (bad chunk URL, wasm fetch):
    // fatal, stay loud — reject everything, terminate, respawn next request.
    if (!booted) {
      failAll(new Error(`Wallet worker failed to load: ${event.message || 'script error'}`));
      return;
    }
    // After boot, an `error` event is a stray uncaught throw (an SDK timer / Rx
    // callback). Every request path in the worker is try/caught, so this is
    // never a request failure and does NOT terminate the worker — surface it
    // (user-visible) but leave the worker and its pending requests intact.
    console.error('Wallet worker error (non-fatal):', event.message || event);
    relayEvent('os/eventSyncMessage', `Wallet worker error: ${event.message || 'script error'}`);
  };
  w.onmessageerror = () => failAll(new Error('Wallet worker response could not be deserialized'));
  return w;
}

export function hostRequest<M extends HostMethod>(method: M, data: MethodData<M>): Promise<MethodResult<M>> {
  // Dev: no real worker (cross-origin dev server) — run the host inline. This
  // whole branch is dead-code-eliminated from production builds.
  if (import.meta.env.DEV) return inlineRequest(method, data);

  const w = (worker ??= spawn());
  const id = nextId++;
  return new Promise<MethodResult<M>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      w.postMessage({ id, method, data } satisfies WorkerRequest);
    } catch (err) {
      // postMessage can throw synchronously (e.g. a non-cloneable payload).
      pending.delete(id);
      reject(err);
    }
  });
}

// --- Dev fallback ----------------------------------------------------------
// Run the host on the offscreen main thread (today's behavior, throttled
// batches). Events go straight out via relayEvent.
type Host = typeof import('./wallet-host');
let inlineHostPromise: Promise<Host> | null = null;
const inlineHost = (): Promise<Host> =>
  (inlineHostPromise ??= import('./wallet-host').then((mod) => {
    mod.setHostEmit(relayEvent);
    return mod;
  }));

async function inlineRequest<M extends HostMethod>(method: M, data: MethodData<M>): Promise<MethodResult<M>> {
  const host = await inlineHost();
  return hostDispatch[method](host, data as never) as Promise<MethodResult<M>>;
}
