// Wire types + error codec for the offscreen-page ⇄ wallet-worker postMessage
// RPC. Shared by the worker entry (evaluated inside the Worker) and the
// offscreen-page bridge.
//
// IMPORTANT: no runtime imports. This module is evaluated inside the dedicated
// worker, where extension APIs (and anything pulling in webextension-polyfill)
// don't exist. Everything here is either a type-only import (erased) or pure JS.

import type { TxStage } from '@shieldedtech/moth-browser';
import type { OffscreenProtocol } from './messaging';
import type { RelayState } from './relay-socket';

// The offscreen → SW events the host emits. Their payloads mirror the
// `os/event*` entries of OffscreenProtocol exactly.
export type HostEvent = 'os/eventBalances' | 'os/eventSyncMessage' | 'os/eventTxStage' | 'os/eventRelayState';
export interface HostEventData {
  'os/eventBalances': string;
  'os/eventSyncMessage': string;
  'os/eventTxStage': TxStage;
  'os/eventRelayState': RelayState;
}

// Every request method the worker answers: the full os/* surface minus the
// synchronous ping (answered on the offscreen thread) and the events (which
// flow the other way).
export type HostMethod = Exclude<keyof OffscreenProtocol, 'os/ping' | HostEvent>;
export type MethodData<M extends HostMethod> = Parameters<OffscreenProtocol[M]>[0];
export type MethodResult<M extends HostMethod> = ReturnType<OffscreenProtocol[M]>;

// page → worker
export interface WorkerRequest {
  id: number;
  method: HostMethod;
  data: unknown;
}

// worker → page: either a correlated response or a fire-and-forget event.
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: unknown };
export type WorkerEventMessage = { [E in HostEvent]: { event: E; data: HostEventData[E] } }[HostEvent];
export type WorkerToPage = WorkerResponse | WorkerEventMessage;

// ---------------------------------------------------------------------------
// Error codec
// ---------------------------------------------------------------------------
// A raw structured clone of an Error keeps name/message/stack but drops custom
// own props (e.g. WalletError.category) and the subclass identity. We serialize
// to the same plain-object shape `@aklinker1/zero-serialize-error` uses (that's
// what @webext-core/messaging applies on the next SW/UI hop), so a WalletError
// thrown in the worker reaches the UI byte-identical to today's single-hop path.

interface SerializedError {
  name: string;
  message: string;
  stack: string;
  cause?: unknown;
  [key: string]: unknown;
}

function isSerializedError(value: unknown): value is SerializedError {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as SerializedError).name === 'string' &&
    typeof (value as SerializedError).message === 'string' &&
    typeof (value as SerializedError).stack === 'string'
  );
}

function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** Turn a thrown value into a postMessage-safe payload. Errors become the plain
 *  `{name, message, stack, cause?, ...own enumerable props}` shape; other throws
 *  pass through when structured-cloneable, else degrade to `String(value)`. */
export function serializeHostError(value: unknown): unknown {
  if (value instanceof Error) {
    const serialized: SerializedError = {
      name: value.name,
      message: value.message,
      stack: value.stack ?? '',
    };
    if (value.cause != null) serialized.cause = serializeHostError(value.cause);
    // Own enumerable props (WalletError.category and any the core attaches).
    for (const [key, val] of Object.entries(value)) {
      serialized[key] = serializeHostError(val);
    }
    return serialized;
  }
  return isCloneable(value) ? value : String(value);
}

/** Inverse of serializeHostError: rebuild an Error (with name/stack/cause and
 *  custom own props restored) so the bridge can reject with it. Non-error
 *  payloads pass through unchanged. */
export function deserializeHostError(value: unknown): unknown {
  if (!isSerializedError(value)) return value;
  const error = new Error(value.message, value.cause != null ? { cause: deserializeHostError(value.cause) } : undefined);
  error.name = value.name;
  error.stack = value.stack;
  for (const [key, val] of Object.entries(value)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause') {
      (error as unknown as Record<string, unknown>)[key] = val;
    }
  }
  return error;
}
