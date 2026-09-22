// Whether a DUST address had any generation entries at or below a chain height. This is
// the fact that lets a wallet with no usable birthday be seeded from the reference: all
// of its DUST descends from generation entries owned by its dust key.

import {IndexerClient} from '../network/indexer-client.js';
import {wsUrl} from './cursor-witness.js';
import type {DustHistoryVerdict} from './preseed-parts.js';

export type {DustHistoryVerdict};

/** The slice of a WebSocket the probe uses, so tests can drive a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, protocol: string) => SocketLike;

export interface ProbeOptions {
  timeoutMs?: number;
  socket?: SocketFactory;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const SUBSCRIPTION_ID = '1';

// The indexer's range is inclusive and its `dustGenerationEndIndex` exclusive, so the
// last entry at the reference height is `endIndex - 1`.
//
// The integers are inlined rather than sent as variables. Sent as variables the
// public preprod indexer intermittently answers `Invalid value for argument
// "endIndex", expected type "Int"` — the same request with the ints in the query
// text succeeds. The probe mapped that to `unknown`, which is the safe direction
// (sync from genesis), but it made the fast path fail for no reason.
export function dustHistoryQuery(dustAddress: string, endIndexInclusive: number): string {
  return `subscription { dustGenerations(dustAddress: ${JSON.stringify(dustAddress)}, startIndex: 0, endIndex: ${Math.max(0, Math.floor(endIndexInclusive))}) {
    __typename
    ... on DustGenerationsItem { generationMtIndex }
    ... on DustGenerationDtimeUpdateItem { generationMtIndex }
    ... on DustGenerationsProgress { highestIndex }
  } }`;
}

export type DustGenerationsMessage =
  | {kind: 'ack'}
  | {kind: 'item'}
  | {kind: 'dtime'}
  | {kind: 'progress'; highestIndex: number}
  | {kind: 'complete'}
  | {kind: 'error'; detail: string}
  | {kind: 'ping'}
  | {kind: 'other'};

/** Classify one graphql-transport-ws frame of the dustGenerations subscription. */
export function classifyDustGenerationsMessage(raw: unknown): DustGenerationsMessage {
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
      const payload = msg.payload as {data?: {dustGenerations?: {__typename?: string; highestIndex?: number}}; errors?: unknown[]} | undefined;
      if (payload?.errors && payload.errors.length > 0) return {kind: 'error', detail: JSON.stringify(payload.errors)};
      const event = payload?.data?.dustGenerations;
      switch (event?.__typename) {
        case 'DustGenerationsItem':
          return {kind: 'item'};
        case 'DustGenerationDtimeUpdateItem':
          return {kind: 'dtime'};
        case 'DustGenerationsProgress':
          return {kind: 'progress', highestIndex: event.highestIndex ?? -1};
        default:
          return {kind: 'other'};
      }
    }
    default:
      return {kind: 'other'};
  }
}

/**
 * Ask the indexer whether `dustAddress` owns any generation entry below
 * `endIndexExclusive`. A bounded range ends with `complete`, so "none" is a positive
 * answer rather than silence; anything short of that answer is `unknown`.
 */
export function probeDustGenerations(
  indexerUrl: string,
  dustAddress: string,
  endIndexExclusive: number,
  opts: ProbeOptions = {},
): Promise<DustHistoryVerdict> {
  if (endIndexExclusive <= 0) return Promise.resolve({kind: 'none'});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connect: SocketFactory = opts.socket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike);

  return new Promise<DustHistoryVerdict>((resolve) => {
    let socket: SocketLike;
    try {
      socket = connect(wsUrl(indexerUrl), 'graphql-transport-ws');
    } catch (err) {
      resolve({kind: 'unknown', reason: `could not open ${wsUrl(indexerUrl)}: ${String(err)}`});
      return;
    }
    let settled = false;
    let entries = 0;
    const finish = (verdict: DustHistoryVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish({kind: 'unknown', reason: `no answer within ${timeoutMs}ms`}), timeoutMs);

    socket.onopen = () => socket.send(JSON.stringify({type: 'connection_init'}));
    socket.onerror = () => finish({kind: 'unknown', reason: `could not reach ${wsUrl(indexerUrl)}`});
    socket.onmessage = (event) => {
      const message = classifyDustGenerationsMessage(event.data);
      switch (message.kind) {
        case 'ack':
          socket.send(
            JSON.stringify({
              id: SUBSCRIPTION_ID,
              type: 'subscribe',
              payload: {query: dustHistoryQuery(dustAddress, endIndexExclusive - 1)},
            }),
          );
          return;
        case 'ping':
          socket.send(JSON.stringify({type: 'pong'}));
          return;
        case 'item':
        case 'dtime':
          // One owned entry is enough to decide; a dtime update implies the entry exists.
          entries += 1;
          finish({kind: 'some', entries});
          return;
        case 'complete':
          finish(entries > 0 ? {kind: 'some', entries} : {kind: 'none'});
          return;
        case 'error':
          finish({kind: 'unknown', reason: `indexer rejected the query: ${message.detail}`});
          return;
        default:
          return;
      }
    };
  });
}

/**
 * Whether `dustAddress` had any DUST generation history at or below `height`. Fails
 * closed: an indexer that cannot report the tree size at that height yields `unknown`.
 */
export async function dustHistoryBefore(
  indexer: IndexerClient,
  indexerUrl: string,
  dustAddress: string,
  height: number,
  opts: ProbeOptions = {},
): Promise<DustHistoryVerdict> {
  const size = await indexer.getDustGenerationEndIndex(height);
  if (size === null) {
    return {kind: 'unknown', reason: `indexer does not report the generation tree size at height ${height}`};
  }
  return probeDustGenerations(indexerUrl, dustAddress, size, opts);
}
