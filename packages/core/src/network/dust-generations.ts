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

import {indexerWsUrl} from './first-activity.js';

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
  /** True when collection stopped on the time budget rather than catching up. */
  readonly truncated: boolean;
}

/**
 * `endIndex` is REQUIRED and inclusive — omitting it fails the subscription, and
 * the failure arrives as a `next` message carrying `errors`, not as the protocol
 * `error` type. A reader that only watches for the latter records zero entries and
 * reports "no DUST generation", which is the wrong answer stated confidently.
 *
 * The bound is generation-tree indices, not event ids, and nothing local maps a
 * wallet to its highest index — so it is deliberately wide. Measured on preprod:
 * a bound of 100,000 returned nothing for an address whose entries sit at 338,505,
 * while `highestIndex` merely echoed the bound back, giving no hint that the
 * window was too small.
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

/**
 * Collect the generation entries for `dustAddress`.
 *
 * Bounded by time, not by completeness: the subscription stays open for future
 * entries, so there is no "done" to wait for. `DustGenerationsProgress` marks
 * catch-up, and arriving at it ends collection; otherwise the budget does, and
 * `truncated` says so rather than presenting a partial answer as whole.
 */
export async function dustGenerationsFor(
  indexerUrl: string,
  dustAddress: string,
  opts: {timeoutMs?: number; quietMs?: number; startIndex?: number; endIndex?: number} = {},
): Promise<DustGenerationsResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const from = opts.startIndex ?? 0;
  // Wide by default: see the note on QUERY. Too small a bound returns nothing and
  // says nothing about why.
  const to = opts.endIndex ?? 2_000_000_000;
  // With a wide bound the indexer sends the matching entries and then simply
  // stops — no Progress marker, no `complete`. So "done" is a quiet gap, not a
  // signal. Without this the call always burns the whole budget and reports
  // itself truncated even though it saw everything.
  const quietMs = opts.quietMs ?? 2_500;
  const ws = new WebSocket(indexerWsUrl(indexerUrl), 'graphql-transport-ws');
  const entries: DustGenerationEntry[] = [];
  let dtimeUpdates = 0;
  let highestIndex: number | null = null;

  return new Promise<DustGenerationsResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quiet) clearTimeout(quiet);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve({entries, dtimeUpdates, highestIndex, truncated: true})), timeoutMs);

    // Reset on every event; firing means the stream went quiet after delivering
    // something, which is as close to "caught up" as this subscription offers.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const nudgeQuiet = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(() => resolve({entries, dtimeUpdates, highestIndex, truncated: false})), quietMs);
    };

    ws.onopen = () => ws.send(JSON.stringify({type: 'connection_init'}));
    ws.onerror = () => finish(() => reject(new Error(`Could not reach ${indexerWsUrl(indexerUrl)}`)));

    ws.onmessage = (event: MessageEvent) => {
      let msg: {type?: string; payload?: unknown};
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
            payload: {query: QUERY, variables: {address: dustAddress, from, to}},
          }),
        );
        return;
      }

      if (msg.type === 'next') {
        const payload = msg.payload as
          | {data?: {dustGenerations?: Record<string, unknown>}; errors?: {message?: string}[]}
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
          nudgeQuiet();
          return;
        }

        if (e.__typename === 'DustGenerationsProgress') {
          if (typeof e.highestIndex === 'number') highestIndex = e.highestIndex;
          // Caught up. Anything further would be live traffic, which a status
          // command has no business waiting for.
          finish(() => resolve({entries, dtimeUpdates, highestIndex, truncated: false}));
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
          nudgeQuiet();
        }
        return;
      }

      if (msg.type === 'error') {
        finish(() => reject(new Error(`Indexer rejected the subscription: ${JSON.stringify(msg.payload)}`)));
        return;
      }
      if (msg.type === 'complete') finish(() => resolve({entries, dtimeUpdates, highestIndex, truncated: false}));
    };
  });
}
