// The chain's own record of a dust key's generation, read from the indexer.
//
// A wallet's dust view is derived incrementally from the event stream and is
// never re-derived from the chain (see wallet-sdk-dust-wallet Sync.js). The
// indexer's `dustGenerations(dustAddress)` subscription is the independent
// ground truth: every generation entry owned by the key, with the backing NIGHT,
// its creation time and — once the NIGHT is spent — its dtime. Every dust coin a
// wallet can hold descends from exactly one of these entries, so "live entries
// with no coin in the local view" is the precise shape of a lost coin.
//
// Protocol notes, all observed against the public preprod indexer:
//   - graphql-transport-ws over the indexer's `/ws` endpoint.
//   - Int arguments are INLINED into the query text. Sent as GraphQL variables
//     the server intermittently answers `Invalid value for argument "endIndex",
//     expected type "Int"`; the same request inlined succeeds.
//   - The bounded range usually ends with `complete`, but not always. A quiet
//     gap after the last frame is therefore also accepted as the end.
//   - An entry is generating iff no DustGenerationDtimeUpdateItem names its
//     generationMtIndex.

import type {SocketFactory, SocketLike} from './dust-history.js';
import {wsUrl} from './cursor-witness.js';

export type {SocketFactory, SocketLike};

/** One generation entry owned by the dust address, as the indexer reports it. */
export interface DustGenerationEntry {
  readonly generationMtIndex: number;
  /** Index of the initial dust commitment in the commitment tree. */
  readonly commitmentMtIndex: number;
  /** Backing NIGHT, in STAR. */
  readonly night: bigint;
  /** Initial value of the first dust coin, in SPECK. */
  readonly initialValue: bigint;
  /** Creation time, epoch ms. */
  readonly ctimeMs: number;
  /** The backing NIGHT UTXO's initial nonce (hex) — the key that ties a local dust coin to this entry. */
  readonly backingNight: string;
  readonly transactionHash: string;
  /** Set once the backing NIGHT was spent: generation ended then. Epoch ms. */
  readonly dtimeMs: number | null;
}

export type DustGenerationsFrame =
  | {kind: 'ack'}
  | {kind: 'ping'}
  | {kind: 'item'; entry: DustGenerationEntry}
  | {kind: 'dtime'; generationMtIndex: number; dtimeMs: number}
  | {kind: 'progress'; highestIndex: number}
  | {kind: 'complete'}
  | {kind: 'error'; detail: string}
  | {kind: 'other'};

function toMs(seconds: unknown): number {
  const n = typeof seconds === 'string' ? Number(seconds) : (seconds as number);
  if (!Number.isFinite(n)) return 0;
  // The indexer reports seconds; a value already in ms is left alone.
  return n > 1e12 ? n : n * 1000;
}

function toBigInt(v: unknown): bigint {
  try {
    return BigInt(v as string | number | bigint);
  } catch {
    return 0n;
  }
}

/** Classify one graphql-transport-ws frame of the dustGenerations subscription. */
export function parseDustGenerationsFrame(raw: unknown): DustGenerationsFrame {
  let msg: {type?: string; payload?: unknown};
  try {
    msg = JSON.parse(String(raw)) as typeof msg;
  } catch {
    return {kind: 'other'};
  }
  switch (msg.type) {
    case 'connection_ack':
      return {kind: 'ack'};
    case 'ping':
      return {kind: 'ping'};
    case 'complete':
      return {kind: 'complete'};
    case 'error':
      return {kind: 'error', detail: JSON.stringify(msg.payload)};
    case 'next': {
      const payload = msg.payload as {data?: {dustGenerations?: Record<string, unknown>}; errors?: unknown[]} | undefined;
      if (payload?.errors && payload.errors.length > 0) return {kind: 'error', detail: JSON.stringify(payload.errors)};
      const ev = payload?.data?.dustGenerations;
      switch (ev?.__typename) {
        case 'DustGenerationsItem':
          return {
            kind: 'item',
            entry: {
              generationMtIndex: Number(ev.generationMtIndex),
              commitmentMtIndex: Number(ev.commitmentMtIndex),
              night: toBigInt(ev.value),
              initialValue: toBigInt(ev.initialValue),
              ctimeMs: toMs(ev.ctime),
              backingNight: String(ev.backingNight ?? ''),
              transactionHash: String(ev.transactionHash ?? ''),
              dtimeMs: null,
            },
          };
        case 'DustGenerationDtimeUpdateItem':
          return {kind: 'dtime', generationMtIndex: Number(ev.generationMtIndex), dtimeMs: toMs(ev.newDtime)};
        case 'DustGenerationsProgress':
          return {kind: 'progress', highestIndex: Number(ev.highestIndex ?? -1)};
        default:
          return {kind: 'other'};
      }
    }
    default:
      return {kind: 'other'};
  }
}

export interface FetchOptions {
  /** Overall deadline. */
  timeoutMs?: number;
  /** A stream that stays silent this long after its last frame is taken as ended. */
  quietMs?: number;
  socket?: SocketFactory;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_QUIET_MS = 4_000;

/** The subscription text, with the integers inlined (see the header). */
export function dustGenerationsQuery(dustAddress: string, endIndexExclusive: number): string {
  // The indexer's range is inclusive and `Block.dustGenerationEndIndex` exclusive.
  const end = Math.max(0, Math.floor(endIndexExclusive) - 1);
  const address = JSON.stringify(dustAddress);
  return `subscription { dustGenerations(dustAddress: ${address}, startIndex: 0, endIndex: ${end}) {
    __typename
    ... on DustGenerationsItem { commitmentMtIndex generationMtIndex value initialValue backingNight ctime transactionHash }
    ... on DustGenerationDtimeUpdateItem { generationMtIndex newDtime }
    ... on DustGenerationsProgress { highestIndex }
  } }`;
}

export interface DustGenerations {
  readonly entries: readonly DustGenerationEntry[];
  /** Entries whose backing NIGHT is unspent — the ones a wallet must hold a coin for. */
  readonly live: readonly DustGenerationEntry[];
  /** How the stream ended: the indexer's `complete`, or silence after its last frame. */
  readonly endedBy: 'complete' | 'quiet';
}

/**
 * Every generation entry the indexer holds for `dustAddress` below
 * `endIndexExclusive` (the tip's `dustGenerationEndIndex`), with dtime updates
 * folded in. Rejects when the indexer cannot be reached, rejects the query, or
 * says nothing at all before the deadline: an empty answer is only trusted when
 * the stream itself ended.
 */
export function fetchDustGenerations(
  indexerUrl: string,
  dustAddress: string,
  endIndexExclusive: number,
  opts: FetchOptions = {},
): Promise<DustGenerations> {
  if (endIndexExclusive <= 0) return Promise.resolve({entries: [], live: [], endedBy: 'complete'});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const connect: SocketFactory = opts.socket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike);

  return new Promise<DustGenerations>((resolve, reject) => {
    let socket: SocketLike;
    try {
      socket = connect(wsUrl(indexerUrl), 'graphql-transport-ws');
    } catch (err) {
      reject(new Error(`could not open ${wsUrl(indexerUrl)}: ${String(err)}`));
      return;
    }
    const items: DustGenerationEntry[] = [];
    const dtimes = new Map<number, number>();
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const close = () => {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
    const finish = (endedBy: 'complete' | 'quiet') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      close();
      const entries = items
        .map((it) => (dtimes.has(it.generationMtIndex) ? {...it, dtimeMs: dtimes.get(it.generationMtIndex)!} : it))
        .sort((a, b) => a.generationMtIndex - b.generationMtIndex);
      resolve({entries, live: entries.filter((e) => e.dtimeMs === null), endedBy});
    };
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      close();
      reject(new Error(reason));
    };
    const deadline = setTimeout(() => fail(`no answer from ${wsUrl(indexerUrl)} within ${timeoutMs}ms`), timeoutMs);
    // Only armed once the subscription has answered at all: silence before the
    // first frame is an indexer that has not answered, not an empty range.
    const touch = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), quietMs);
    };

    socket.onopen = () => socket.send(JSON.stringify({type: 'connection_init'}));
    socket.onerror = () => fail(`could not reach ${wsUrl(indexerUrl)}`);
    socket.onmessage = (event) => {
      const frame = parseDustGenerationsFrame(event.data);
      switch (frame.kind) {
        case 'ack':
          socket.send(
            JSON.stringify({id: '1', type: 'subscribe', payload: {query: dustGenerationsQuery(dustAddress, endIndexExclusive)}}),
          );
          return;
        case 'ping':
          socket.send(JSON.stringify({type: 'pong'}));
          return;
        case 'item':
          items.push(frame.entry);
          touch();
          return;
        case 'dtime':
          dtimes.set(frame.generationMtIndex, frame.dtimeMs);
          touch();
          return;
        case 'progress':
          touch();
          return;
        case 'complete':
          finish('complete');
          return;
        case 'error':
          fail(`indexer rejected the dustGenerations query: ${frame.detail}`);
          return;
        default:
          return;
      }
    };
  });
}

/** Where the indexer's dust event stream currently ends. */
export interface DustTip {
  /** The first event id at or after the probe's cursor. */
  readonly id: number;
  /** The highest dust event id the indexer holds right now. */
  readonly maxId: number;
}

/**
 * Read the indexer's current dust tip by opening the event subscription at
 * `fromId` and taking the first frame's `maxId`. Every frame carries it, so one
 * frame is enough. Resolves null when the stream yields nothing (a cursor past
 * the end, which on a stream that has moved is itself a signal); rejects when
 * the indexer cannot be reached or refuses the subscription.
 *
 * This is the independent answer to "is my dust cursor really at the tip". The
 * SDK only learns `maxId` when an event arrives, so a subscription that has
 * silently stopped delivering leaves `appliedIndex == highestRelevantWalletIndex`
 * frozen together and the wallet looking synced while it falls behind.
 */
export function readDustTip(indexerUrl: string, fromId: number, opts: FetchOptions = {}): Promise<DustTip | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const connect: SocketFactory = opts.socket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike);
  return new Promise<DustTip | null>((resolve, reject) => {
    let socket: SocketLike;
    try {
      socket = connect(wsUrl(indexerUrl), 'graphql-transport-ws');
    } catch (err) {
      reject(new Error(`could not open ${wsUrl(indexerUrl)}: ${String(err)}`));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);
    const cursor = Math.max(0, Math.floor(fromId));
    socket.onopen = () => socket.send(JSON.stringify({type: 'connection_init'}));
    socket.onerror = () => finish(() => reject(new Error(`could not reach ${wsUrl(indexerUrl)}`)));
    socket.onmessage = (event) => {
      let msg: {type?: string; payload?: unknown};
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'connection_ack':
          socket.send(
            JSON.stringify({
              id: '1',
              type: 'subscribe',
              payload: {query: `subscription { dustLedgerEvents(id: ${cursor}) { id maxId } }`},
            }),
          );
          return;
        case 'ping':
          socket.send(JSON.stringify({type: 'pong'}));
          return;
        case 'next': {
          const ev = (msg.payload as {data?: {dustLedgerEvents?: {id?: number; maxId?: number}}} | undefined)?.data
            ?.dustLedgerEvents;
          if (!ev || typeof ev.id !== 'number' || typeof ev.maxId !== 'number') return;
          finish(() => resolve({id: ev.id!, maxId: ev.maxId!}));
          return;
        }
        case 'error':
          finish(() => reject(new Error(`indexer rejected the dust tip subscription: ${JSON.stringify(msg.payload)}`)));
          return;
        case 'complete':
          finish(() => resolve(null));
          return;
        default:
          return;
      }
    };
  });
}
