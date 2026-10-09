/**
 * DUST generation entries for a Midnight DUST address.
 *
 * The indexer splits this question in two, and the halves take different keys:
 *
 * - `dustGenerationStatus(cardanoRewardAddresses)` — "is this Cardano holder
 *   registered, and what is their rate and capacity". Needs a Cardano stake
 *   address, which moth does not derive.
 * - `dustGenerations(dustAddress)` — "what generation entries exist for this DUST
 *   address". Needs only what moth already derives.
 *
 * `moth dust status` used to ask the first question with a Midnight address,
 * which the indexer rejects on the HRP before looking anything up, so the command
 * could never work (#54). This answers the second question instead, which is
 * almost certainly what someone typing that command wants.
 *
 * Subscription rather than query: only the subscription form is keyed by
 * `dustAddress`. Both query forms take Cardano addresses only.
 */

import { IndexerClient } from './indexer-client.js';
import { wsUrl } from '../sync/cursor-witness.js';

/** One generation entry accruing to a DUST address. */
export interface DustGenerationEntry {
  readonly generationMtIndex: number;
  readonly commitmentMtIndex: number;
  /** Current value in DUST's smallest unit. */
  readonly value: string;
  /** Value at creation, before decay. */
  readonly initialValue: string;
  /** Creation time, seconds. */
  readonly ctime: number;
  /** The NIGHT UTXO backing this generation. */
  readonly backingNight: string;
  readonly transactionHash: string;
}

export interface DustGenerationsResult {
  readonly entries: DustGenerationEntry[];
  /**
   * Decay-time updates seen. Not new generation, so they are counted rather than
   * listed — but their presence means the address IS generating, which matters
   * when no `DustGenerationsItem` falls inside the window.
   */
  readonly dtimeUpdates: number;
  /** Highest generation index the indexer reports, when it said so. */
  readonly highestIndex: number | null;
  /** True when collection stopped on the time budget rather than reaching `complete`. */
  readonly truncated: boolean;
}

/**
 * `endIndex` is REQUIRED — omitting it fails the subscription, and the failure
 * arrives as a `next` message carrying `errors`, not as the protocol `error` type.
 * A reader that only watches for the latter records zero entries and reports "no
 * DUST generation", which is the wrong answer stated confidently.
 *
 * The bound comes from the chain, not from a guess. Per the indexer's schema:
 *
 *   Block.dustGenerationEndIndex — "The dust generation tree end index at this
 *     block; exclusive, i.e. the next free index."
 *   dustGenerations — "Subscribe to dust generation entries for a dust address in
 *     `[start_index, end_index]` inclusive. `dustGenerationEndIndex` is exclusive,
 *     pass `dustGenerationEndIndex - 1`."
 *
 * Getting this from the chain matters for more than tidiness. A bounded range
 * terminates with `complete`, so "no entries" is an answer rather than a silence
 * that has to be timed out. A guessed bound gives neither: measured on preprod, a
 * bound of 100,000 returned nothing for an address whose entries sit at 338,505,
 * while `highestIndex` merely echoed the bound back.
 */
const QUERY = `subscription($address: DustAddress!, $from: Int!, $to: Int!) {
  dustGenerations(dustAddress: $address, startIndex: $from, endIndex: $to) {
    __typename
    ... on DustGenerationsItem {
      generationMtIndex commitmentMtIndex value initialValue ctime backingNight transactionHash
    }
    ... on DustGenerationDtimeUpdateItem { generationMtIndex }
    ... on DustGenerationsProgress { highestIndex }
  }
}`;

/** The slice of a WebSocket this reader uses, so tests can drive a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DustGenerationsOptions {
  timeoutMs?: number;
  startIndex?: number;
  /**
   * Inclusive upper bound. Omitted, it is read from the chain — the generation
   * tree's size at the latest block, minus one.
   */
  endIndex?: number;
  socket?: (url: string, protocol: string) => SocketLike;
}

/**
 * Collect the generation entries for `dustAddress`.
 *
 * Bounded by the generation tree's size, so the subscription ends with `complete`
 * rather than staying open for live traffic. The time budget is a backstop for an
 * indexer that goes quiet, and `truncated` says when it was the thing that fired.
 */
export async function dustGenerationsFor(
  indexerUrl: string,
  dustAddress: string,
  opts: DustGenerationsOptions = {},
): Promise<DustGenerationsResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const from = opts.startIndex ?? 0;

  let to = opts.endIndex;
  if (to === undefined) {
    const size = await new IndexerClient(indexerUrl).getDustGenerationEndIndex();
    if (size === null) {
      throw new Error(
        'The indexer did not report the DUST generation tree size, so this query has no bound. ' +
          'It needs indexer 4.2 or newer.',
      );
    }
    to = size - 1;
  }

  const entries: DustGenerationEntry[] = [];
  let dtimeUpdates = 0;
  let highestIndex: number | null = null;

  if (to < from) return { entries, dtimeUpdates, highestIndex, truncated: false };

  const connect =
    opts.socket ?? ((url: string, protocol: string) => new WebSocket(url, protocol) as unknown as SocketLike);
  const endpoint = wsUrl(indexerUrl);
  const ws = connect(endpoint, 'graphql-transport-ws');

  return new Promise<DustGenerationsResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => resolve({ entries, dtimeUpdates, highestIndex, truncated: true })),
      timeoutMs,
    );
    const done = () => finish(() => resolve({ entries, dtimeUpdates, highestIndex, truncated: false }));

    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = () => finish(() => reject(new Error(`Could not reach ${endpoint}`)));

    ws.onmessage = (event: { data: unknown }) => {
      let msg: { type?: string; payload?: unknown };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === 'connection_ack') {
        ws.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: { query: QUERY, variables: { address: dustAddress, from, to } },
          }),
        );
        return;
      }

      // Keepalive. An unanswered ping is a dropped connection on some servers.
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'next') {
        const payload = msg.payload as
          | { data?: { dustGenerations?: Record<string, unknown> }; errors?: { message?: string }[] }
          | undefined;

        // GraphQL errors ride in on `next`, not on the protocol's `error` type.
        // Ignoring them is how a missing argument became "no DUST generation".
        if (payload?.errors?.length) {
          const first = payload.errors[0]?.message ?? 'unknown error';
          finish(() => reject(new Error(`Indexer rejected the dust-generations subscription: ${first}`)));
          return;
        }

        const e = payload?.data?.dustGenerations;
        if (!e) return;

        if (e.__typename === 'DustGenerationDtimeUpdateItem') {
          dtimeUpdates += 1;
          return;
        }

        if (e.__typename === 'DustGenerationsProgress') {
          if (typeof e.highestIndex === 'number') highestIndex = e.highestIndex;
          return;
        }

        if (e.__typename === 'DustGenerationsItem') {
          entries.push({
            generationMtIndex: Number(e.generationMtIndex ?? 0),
            commitmentMtIndex: Number(e.commitmentMtIndex ?? 0),
            value: String(e.value ?? '0'),
            initialValue: String(e.initialValue ?? '0'),
            ctime: Number(e.ctime ?? 0),
            backingNight: String(e.backingNight ?? ''),
            transactionHash: String(e.transactionHash ?? ''),
          });
        }
        return;
      }

      if (msg.type === 'error') {
        finish(() => reject(new Error(`Indexer rejected the subscription: ${JSON.stringify(msg.payload)}`)));
        return;
      }
      if (msg.type === 'complete') done();
    };
  });
}
