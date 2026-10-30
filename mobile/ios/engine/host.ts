// The engine's link to moth's wallet worker, plus the state the extension's service worker
// keeps there: unlocked sessions and network configs.
import WalletWorker from 'moth-ext/offscreen/wallet-worker?worker';
import {
  deserializeHostError,
  type HostEvent,
  type HostEventData,
  type HostMethod,
  type MethodData,
  type MethodResult,
  type WorkerToPage,
} from 'moth-ext/offscreen/worker-rpc';
import type { UnlockedWallet } from 'moth-ext/offscreen/messaging';
import { deserializeBalances } from 'moth-ext/messaging/balances-json';
// Only dependency-free core modules load on this page; anything reaching the wallet SDK would
// load the ledger WASM on the main thread, which the worker exists to avoid.
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { DEFAULT_NETWORKS, canonicalNetworkId, type NetworkConfig } from '@shieldedtech/moth-wallet/types/network';

declare global {
  interface Window {
    MOTH_PROVER_URL?: string;
    webkit?: { messageHandlers?: Record<string, { postMessage(v: unknown): void }> };
  }
}

// --- Events to Swift -------------------------------------------------------------

export type EngineEvent =
  | { event: 'balances'; data: PlainBalances }
  | { event: 'syncMessage'; data: string }
  | { event: 'txStage'; data: HostEventData['os/eventTxStage'] }
  | { event: 'relayState'; data: HostEventData['os/eventRelayState'] }
  | { event: 'workerError'; data: string }
  | { event: 'approval'; data: { id: number; origin: string; kind: string; payload: unknown } }
  | { event: 'ready'; data: null };

export function emit(e: EngineEvent): void {
  window.webkit?.messageHandlers?.moth?.postMessage(e);
}

// --- Worker RPC (as packages/extension/lib/offscreen/worker-bridge.ts) -------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function spawn(): Worker {
  const w = new WalletWorker({ name: 'moth-wallet-host' });
  w.onmessage = (event: MessageEvent<WorkerToPage>) => {
    const msg = event.data;
    if ('event' in msg) return onHostEvent(msg.event, msg.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(deserializeHostError(msg.error));
  };
  // A crashed worker fails everything in flight; the next call starts a fresh one, which
  // restores from the persisted sync state.
  w.onerror = (event) => {
    const error = new Error(`wallet worker failed: ${event.message || 'unknown error'}`);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    worker = null;
    sessions.clear();
    emit({ event: 'workerError', data: error.message });
  };
  return w;
}

export function call<M extends HostMethod>(method: M, data: MethodData<M>): Promise<Awaited<MethodResult<M>>> {
  worker ??= spawn();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject: (e) => reject(readable(e)) });
    worker!.postMessage({ id, method, data });
  });
}

/** An error whose message includes its causes; SDK errors often carry the detail as objects. */
function readable(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const cause = (err as { cause?: unknown }).cause;
  let message = err.message;
  if (/\[object Object\]/.test(message)) {
    const detail = describe(cause ?? Object.fromEntries(Object.entries(err)));
    if (detail) message = message.replace('[object Object]', detail);
  } else {
    // Wrapper errors (e.g. "Could not reach Blockfrost") keep the provider's reason in `cause`.
    const detail = describe(cause);
    if (detail && !message.includes(detail)) message = `${message} (${detail})`;
  }
  return message === err.message ? err : Object.assign(new Error(message, { cause: err }), { name: err.name });
}

function describe(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return '';
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  const own = typeof record.message === 'string' && record.message !== '[object Object]' ? record.message : '';
  const nested = describe(record.cause ?? record.error, depth + 1);
  if (own || nested) return [own, nested].filter(Boolean).join(': ');
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 500);
  } catch {
    return '';
  }
}

function onHostEvent<E extends HostEvent>(event: E, data: HostEventData[E]): void {
  switch (event) {
    case 'os/eventBalances':
      return emit({ event: 'balances', data: plainBalances(deserializeBalances(data as string)) });
    case 'os/eventSyncMessage':
      return emit({ event: 'syncMessage', data: data as string });
    case 'os/eventTxStage':
      return emit({ event: 'txStage', data: data as HostEventData['os/eventTxStage'] });
    case 'os/eventRelayState':
      return emit({ event: 'relayState', data: data as HostEventData['os/eventRelayState'] });
  }
}

// --- Networks ----------------------------------------------------------------------

const prover = { type: 'server', url: window.MOTH_PROVER_URL ?? 'http://127.0.0.1:6300' } as const;

export function networkConfig(network: string): NetworkConfig {
  const id = canonicalNetworkId(network);
  const base = DEFAULT_NETWORKS[id];
  if (!base) throw new Error(`unknown network: ${network}`);
  return { id, nodeUrl: base.nodeUrl, indexerUrl: base.indexerUrl, prover } as NetworkConfig;
}

export async function tipHeight(network: string): Promise<number | undefined> {
  try {
    const r = await fetch(networkConfig(network).indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
      signal: AbortSignal.timeout(15_000),
    });
    const height = (await r.json())?.data?.block?.height;
    return typeof height === 'number' ? height : undefined;
  } catch {
    // No birthday only costs a longer first sync; it never hides funds.
    return undefined;
  }
}

// --- Sessions ------------------------------------------------------------------------

export interface Session {
  readonly unlocked: UnlockedWallet;
  /** The recovery phrase, for Cardano signing; absent for wallets imported from a seed. */
  readonly mnemonic?: string;
}

/** Unlocked wallets by name; their secrets never leave this page. */
export const sessions = new Map<string, Session>();

export function sessionOf(name: string): Session {
  const session = sessions.get(name);
  if (!session) throw new Error(`wallet "${name}" is locked`);
  return session;
}

export const seedOf = (name: string): string => sessionOf(name).unlocked.seedHex;

export function addressOn(entry: { bech32m: Record<string, string> }, network: string): string {
  return entry.bech32m[network] ?? Object.values(entry.bech32m)[0] ?? '';
}

// --- Plain shapes for Swift (bigints as decimal strings) ----------------------------

export interface PlainBalances {
  shielded: Record<string, string>;
  unshielded: Record<string, string>;
  dust: string;
  synced: boolean;
  subProgress: WalletBalances['subProgress'];
  /** DUST capacity and generation; amounts in SPECK or STAR as decimal strings. */
  dustGeneration: {
    limit: string;
    designated: string;
    registeredNight: string;
    ratePerDay: string;
    fillTime: number | null;
    registered: boolean;
  } | null;
}

export function plainBalances(b: WalletBalances): PlainBalances {
  const strings = (r: Record<string, bigint>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
  const g = b.dustGeneration;
  return {
    shielded: strings(b.shielded),
    unshielded: strings(b.unshielded),
    dust: String(b.dust),
    synced: b.synced,
    subProgress: b.subProgress,
    dustGeneration: g
      ? {
          limit: String(g.limit),
          designated: String(g.designated),
          registeredNight: String(g.registeredNight),
          ratePerDay: String(g.ratePerDay),
          fillTime: g.fillTime.getTime() > 0 ? g.fillTime.getTime() / 1000 : null,
          registered: g.registered,
        }
      : null,
  };
}
