// Moth engine: the bridge between the Swift app and moth's wallet worker.
//
// The wallet itself is the extension's dedicated worker (packages/extension/lib/offscreen/
// wallet-worker.ts), unmodified: the wallet SDK and ledger WASM run there, off this page's
// main thread, and answer the same os/* RPC the extension's offscreen document uses.
//
// This page adds two things the extension's service worker provides there:
//   - a session: the decrypted seed stays in this page's memory and never crosses to Swift;
//   - network configs, with proving pointed at the in-app native prover.
//
// Swift calls `window.moth.<fn>(...)` through callAsyncJavaScript and receives events on
// the `moth` script message handler.
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
import { deserializeBalances } from 'moth-ext/messaging/balances-json';
// Only dependency-free core modules at runtime: anything that reaches the wallet SDK would load
// the ledger WASM on this page's main thread, which is what the worker is there to avoid.
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { DEFAULT_NETWORKS, canonicalNetworkId, type NetworkConfig } from '@shieldedtech/moth-wallet/types/network';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { parseNightAmount } from '@shieldedtech/moth-wallet/wallet/night-amount';

declare global {
  interface Window {
    MOTH_PROVER_URL?: string;
    moth: typeof api;
    webkit?: { messageHandlers?: Record<string, { postMessage(v: unknown): void }> };
  }
}

// --- Swift event channel -----------------------------------------------------

type EngineEvent =
  | { event: 'balances'; data: PlainBalances }
  | { event: 'syncMessage'; data: string }
  | { event: 'txStage'; data: HostEventData['os/eventTxStage'] }
  | { event: 'relayState'; data: HostEventData['os/eventRelayState'] }
  | { event: 'workerError'; data: string }
  | { event: 'ready'; data: null };

function emit(e: EngineEvent): void {
  window.webkit?.messageHandlers?.moth?.postMessage(e);
}

// --- Worker RPC (as packages/extension/lib/offscreen/worker-bridge.ts) ---------

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
  // A crashed worker (out of memory, most likely) fails everything in flight; the next
  // call starts a fresh one, which restores from the persisted sync state.
  w.onerror = (event) => {
    const error = new Error(`wallet worker failed: ${event.message || 'unknown error'}`);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    worker = null;
    emit({ event: 'workerError', data: error.message });
  };
  return w;
}

function call<M extends HostMethod>(method: M, data: MethodData<M>): Promise<Awaited<MethodResult<M>>> {
  worker ??= spawn();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, method, data });
  });
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

// --- Networks ------------------------------------------------------------------

const prover = { type: 'server', url: window.MOTH_PROVER_URL ?? 'http://127.0.0.1:6300' } as const;

// The public preprod indexer rate-limits; Shielded's mirror serves the same chain.
const OVERRIDES: Record<string, Partial<NetworkConfig>> = {
  preprod: { indexerUrl: 'https://indexer.preprod.shielded.tools/api/v4/graphql' },
};

function networkConfig(network: string): NetworkConfig {
  const id = canonicalNetworkId(network);
  const base = DEFAULT_NETWORKS[id];
  if (!base) throw new Error(`unknown network: ${network}`);
  return { id, nodeUrl: base.nodeUrl, indexerUrl: base.indexerUrl, ...OVERRIDES[id], prover } as NetworkConfig;
}

async function tipHeight(network: string): Promise<number | undefined> {
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

// --- Session ---------------------------------------------------------------------

// Seeds of unlocked wallets, by name. Cleared by lock(); gone when the page unloads.
const seeds = new Map<string, string>();

function seedOf(name: string): string {
  const seed = seeds.get(name);
  if (!seed) throw new Error(`wallet "${name}" is locked`);
  return seed;
}

// --- Plain shapes for Swift (bigints as decimal strings) ---------------------------

interface PlainBalances {
  shielded: Record<string, string>;
  unshielded: Record<string, string>;
  dust: string;
  synced: boolean;
  subProgress: WalletBalances['subProgress'];
}

function plainBalances(b: WalletBalances): PlainBalances {
  const strings = (r: Record<string, bigint>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
  return { shielded: strings(b.shielded), unshielded: strings(b.unshielded), dust: String(b.dust), synced: b.synced, subProgress: b.subProgress };
}

interface Transfer {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  /** Base units, decimal string. */
  amount: string;
  to: string;
}

// --- API called from Swift -----------------------------------------------------------

const api = {
  list: (network: string) => call('os/walletList', { network }),

  /** Creates a wallet with a fresh recovery phrase, which is returned once for backup. */
  async create(name: string, passphrase: string, network: string) {
    const birthday = await tipHeight(network);
    const { info, mnemonic } = await call('os/walletCreate', { name, passphrase, network, birthday });
    return { name: info.name, mnemonic };
  },

  async importPhrase(name: string, mnemonic: string, passphrase: string, network: string) {
    const info = await call('os/walletImport', { name, mnemonic, passphrase, network });
    return { name: info.name };
  },

  async unlock(name: string, passphrase: string, network: string) {
    const u = await call('os/walletUnlock', { name, passphrase, network });
    seeds.set(name, u.seedHex);
    const pick = (e: { bech32m: Record<string, string> }) => e.bech32m[network] ?? Object.values(e.bech32m)[0] ?? '';
    return {
      name: u.name,
      unshielded: u.address,
      shielded: pick(u.addresses.zswap),
      dust: pick(u.addresses.dust),
      nightTokenId: NIGHT_TOKEN_ID,
    };
  },

  async lock(name: string) {
    seeds.delete(name);
    if (seeds.size === 0) await call('os/syncStop', undefined);
  },

  sync: (name: string, network: string) =>
    call('os/syncEnsure', { seedHex: seedOf(name), walletName: name, network: networkConfig(network) }),

  async balances(name: string, network: string) {
    const json = await call('os/balancesGet', { seedHex: seedOf(name), walletName: name, network: networkConfig(network) });
    return plainBalances(deserializeBalances(json));
  },

  estimateFee: (name: string, network: string, requests: Transfer[]) =>
    call('os/estimateTransferFee', { seedHex: seedOf(name), walletName: name, network: networkConfig(network), requests }),

  send: (name: string, network: string, requests: Transfer[]) =>
    call('os/sendTokens', { seedHex: seedOf(name), walletName: name, network: networkConfig(network), requests }),

  registerDust: (name: string, network: string) =>
    call('os/registerDust', { seedHex: seedOf(name), walletName: name, network: networkConfig(network) }),

  /** NIGHT typed by the user ("1.5") to STAR, as a decimal string. Throws on bad input. */
  parseNight: (text: string) => String(parseNightAmount(text)),
};

window.moth = api;
// Module scripts can finish after the page's load event, so Swift waits for this instead.
emit({ event: 'ready', data: null });
