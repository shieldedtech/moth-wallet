// Offscreen-page side of the worker RPC. Lazily spawns the dedicated worker,
// correlates requests to responses by id, relays host events out over the
// offscreen → SW channel, and falls back to running the host inline under
// `wxt dev` (where a real cross-origin Worker can't load).

import { browser } from 'wxt/browser';
import { openExecutorFrame } from '@shieldedtech/capsule-host-browser';
import { offscreenSend } from './messaging';
import { capsuleHost, hostDispatch } from './host-dispatch';
import { CAPSULE_EXECUTOR_PAGE } from '../capsule/sandbox-csp';
import type { CapsuleConsentDTO } from '../capsule/protocol';
import {
  deserializeHostError,
  type HostEvent,
  type HostEventData,
  type HostMethod,
  type MethodData,
  type MethodResult,
  type PageToWorker,
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
  dropExecutorFrame();
}

// --- The capsule executor --------------------------------------------------
// The sandbox page runs contract code; this document owns its frame (a worker
// cannot) and transfers the one port into it to the worker, which serves the
// runtime on it. One frame per worker instance: a respawned worker gets a
// fresh frame, since the old port went down with the old worker.
let executorFrame: Promise<HTMLIFrameElement> | null = null;

function dropExecutorFrame(): void {
  void executorFrame?.then((frame) => frame.remove()).catch(() => {});
  executorFrame = null;
}

/** The runtime's consent, put to the user by the background; a hop that fails is a refusal. */
function askUser(consent: CapsuleConsentDTO): Promise<boolean> {
  return offscreenSend('os/capsuleConsent', consent).catch(() => false);
}

/** Opens the executor page once and hands its port to whoever runs the runtime: the worker, or the inline host under dev. */
function ensureCapsuleExecutor(w: Worker | null): Promise<void> {
  executorFrame ??= openExecutorFrame(browser.runtime.getURL(`/${CAPSULE_EXECUTOR_PAGE}`)).then(async ({ frame, port }) => {
    if (w !== null) {
      w.postMessage({ kind: 'capsuleExecutorPort' } satisfies PageToWorker, [port]);
    } else {
      const mod = await capsuleHost();
      mod.setCapsuleChannel({
        ask: askUser,
        emit: (data) => relayEvent('os/eventCapsule', data),
        settled: (data) => relayEvent('os/eventCapsuleSettled', data),
        refused: (data) => relayEvent('os/eventCapsuleRefused', data),
        failed: (data) => relayEvent('os/eventCapsuleFailed', data),
      });
      mod.attachExecutor(port);
    }
    return frame;
  });
  return executorFrame.then(() => undefined);
}

const isCapsuleMethod = (method: HostMethod): boolean => method.startsWith('os/capsule');

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
    if ('ask' in message) {
      void askUser(message.consent).then((approved) =>
        w.postMessage({ kind: 'capsuleConsentAnswer', ask: message.ask, approved } satisfies PageToWorker),
      );
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

export async function hostRequest<M extends HostMethod>(method: M, data: MethodData<M>): Promise<MethodResult<M>> {
  // Dev: no real worker (cross-origin dev server) — run the host inline. This
  // whole branch is dead-code-eliminated from production builds.
  if (import.meta.env.DEV) {
    if (isCapsuleMethod(method)) await ensureCapsuleExecutor(null);
    return inlineRequest(method, data);
  }

  const w = (worker ??= spawn());
  if (isCapsuleMethod(method)) await ensureCapsuleExecutor(w);
  const id = nextId++;
  return new Promise<MethodResult<M>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      w.postMessage({ id, method, data } satisfies PageToWorker);
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
