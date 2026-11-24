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

const EVENTS = `
    __typename
    ... on DustGenerationsItem { generationMtIndex }
    ... on DustGenerationDtimeUpdateItem { generationMtIndex }
    ... on DustGenerationsProgress { highestIndex }`;

// Indexer 4.4 and later: the address's owned entries as of one recent block (older ones
// are refused as outside its freshness window), then `complete`. Its dtime updates cover
// `(dtimeCutoffHeight, block]`, so a cutoff at the block's own height adds none.
const SNAPSHOT_QUERY = `subscription ($address: DustAddress!, $blockHash: HexEncoded!, $cutoff: Int!) {
  dustGenerations(dustAddress: $address, blockHash: $blockHash, dtimeCutoffHeight: $cutoff) {${EVENTS}
  }
}`;

// Indexer 4.3: an inclusive index range, then `complete`.
const RANGE_QUERY = `subscription ($address: DustAddress!, $end: Int!) {
  dustGenerations(dustAddress: $address, startIndex: 0, endIndex: $end) {${EVENTS}
  }
}`;

export type DustGenerationsMessage =
  | {kind: 'ack'}
  | {kind: 'item'; index?: number}
  | {kind: 'dtime'; index?: number}
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
      const payload = msg.payload as
        | {data?: {dustGenerations?: {__typename?: string; highestIndex?: number; generationMtIndex?: number}}; errors?: unknown[]}
        | undefined;
      if (payload?.errors && payload.errors.length > 0) return {kind: 'error', detail: JSON.stringify(payload.errors)};
      const event = payload?.data?.dustGenerations;
      switch (event?.__typename) {
        case 'DustGenerationsItem':
          return {kind: 'item', index: event.generationMtIndex};
        case 'DustGenerationDtimeUpdateItem':
          return {kind: 'dtime', index: event.generationMtIndex};
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

/** A verdict, and whether it is `unknown` because the indexer refused the query. */
interface ProbeResult {
  verdict: DustHistoryVerdict;
  rejected: boolean;
}

/**
 * Ask the indexer whether `dustAddress` owns any generation entry below
 * `endIndexExclusive`, with the index-range form of the subscription (indexer 4.3).
 * A bounded range ends with `complete`, so "none" is a positive answer rather than
 * silence; anything short of that answer is `unknown`.
 */
export async function probeDustGenerations(
  indexerUrl: string,
  dustAddress: string,
  endIndexExclusive: number,
  opts: ProbeOptions = {},
): Promise<DustHistoryVerdict> {
  return (await probeRange(indexerUrl, dustAddress, endIndexExclusive, opts)).verdict;
}

function probeRange(indexerUrl: string, dustAddress: string, endIndexExclusive: number, opts: ProbeOptions): Promise<ProbeResult> {
  if (endIndexExclusive <= 0) return Promise.resolve({verdict: {kind: 'none'}, rejected: false});
  return probe(indexerUrl, RANGE_QUERY, {address: dustAddress, end: endIndexExclusive - 1}, endIndexExclusive, opts);
}

/**
 * Run one subscription and count the owned entries it reports below `below`, the
 * generation tree's size at the height in question. The tree only appends, so those
 * are exactly the entries that existed then. An entry without an index counts, since
 * claiming history is the safe error.
 */
function probe(
  indexerUrl: string,
  query: string,
  variables: Record<string, unknown>,
  below: number,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connect: SocketFactory = opts.socket ?? ((url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike);

  return new Promise<ProbeResult>((resolve) => {
    let socket: SocketLike;
    try {
      socket = connect(wsUrl(indexerUrl), 'graphql-transport-ws');
    } catch (err) {
      resolve({verdict: {kind: 'unknown', reason: `could not open ${wsUrl(indexerUrl)}: ${String(err)}`}, rejected: false});
      return;
    }
    let settled = false;
    const finish = (verdict: DustHistoryVerdict, rejected = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve({verdict, rejected});
    };
    const timer = setTimeout(() => finish({kind: 'unknown', reason: `no answer within ${timeoutMs}ms`}), timeoutMs);

    socket.onopen = () => socket.send(JSON.stringify({type: 'connection_init'}));
    socket.onerror = () => finish({kind: 'unknown', reason: `could not reach ${wsUrl(indexerUrl)}`});
    socket.onmessage = (event) => {
      const message = classifyDustGenerationsMessage(event.data);
      switch (message.kind) {
        case 'ack':
          socket.send(JSON.stringify({id: SUBSCRIPTION_ID, type: 'subscribe', payload: {query, variables}}));
          return;
        case 'ping':
          socket.send(JSON.stringify({type: 'pong'}));
          return;
        case 'item':
        case 'dtime':
          // One owned entry is enough to decide; a dtime update implies the entry exists.
          if (message.index === undefined || message.index < below) finish({kind: 'some', entries: 1});
          return;
        case 'complete':
          finish({kind: 'none'});
          return;
        case 'error':
          finish({kind: 'unknown', reason: `indexer rejected the query: ${message.detail}`}, true);
          return;
        default:
          return;
      }
    };
  });
}

/**
 * Whether `dustAddress` had any DUST generation history at or below `height`. Asks with
 * a snapshot at the tip and, if the indexer refuses that (before 4.4), with the index
 * range. Fails closed: an indexer that cannot report the tree size at `height` yields
 * `unknown`.
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
  if (size <= 0) return {kind: 'none'};
  const tip = await indexer.getBlock().catch(() => null);
  let refused = '';
  if (tip?.hash) {
    const snapshot = await probe(indexerUrl, SNAPSHOT_QUERY, {address: dustAddress, blockHash: tip.hash, cutoff: tip.height}, size, opts);
    if (!snapshot.rejected) return snapshot.verdict;
    refused = snapshot.verdict.kind === 'unknown' ? `${snapshot.verdict.reason}; ` : '';
  }
  const range = await probeRange(indexerUrl, dustAddress, size, opts);
  if (range.rejected && range.verdict.kind === 'unknown') {
    return {kind: 'unknown', reason: `${refused}range form: ${range.verdict.reason}`};
  }
  return range.verdict;
}
