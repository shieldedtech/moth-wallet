/**
 * Find the first on-chain activity for an unshielded address.
 *
 * This exists to derive a birthday instead of asking the user for a date. The
 * indexer indexes unshielded transactions by address, so the answer is one round
 * trip rather than a chain walk: subscribe from transaction id 0 and take the
 * first event.
 *
 * IMPORTANT — this covers UNSHIELDED activity only, and that is a property of
 * the indexer, not of this code. Shielded coins are found by trial-decrypting
 * every output with a viewing key; there is no address to index, so
 * `shieldedTransactions` needs a `connect(viewingKey)` session and cannot answer
 * "when did this address first appear". DUST is address-keyed
 * (`dustGenerations`) but only ever follows NIGHT the wallet already holds.
 *
 * So a height from here is NOT automatically a safe birthday: a shielded receive
 * can predate the first unshielded transaction, and a birthday set after it
 * leaves those coins unfindable until a rescan. Callers must present it as a
 * suggestion with that caveat, never apply it silently.
 */

export interface FirstActivity {
  /** Block height of the earliest unshielded transaction for the address. */
  readonly height: number;
  /** Block timestamp, in milliseconds. */
  readonly timestamp: number;
  /** Indexer transaction id, ascending across the chain. */
  readonly transactionId: number;
  readonly hash: string;
}

/** Derive the subscription endpoint from the indexer's HTTP URL. */
export function indexerWsUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  return url.toString();
}

const QUERY = `subscription($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address, transactionId: 0) {
    __typename
    ... on UnshieldedTransaction {
      transaction { id hash block { height timestamp } }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

/**
 * The earliest unshielded transaction for `address`, or null if it has none.
 *
 * Null is a real answer, not a failure: an address the chain has never seen has
 * no first transaction, which is exactly the case where the chain tip is a sound
 * birthday. A network problem throws instead, so a caller never mistakes "could
 * not ask" for "nothing there" and asserts a birthday it has not verified.
 */
export async function firstUnshieldedActivity(
  indexerUrl: string,
  address: string,
  opts: {timeoutMs?: number} = {},
): Promise<FirstActivity | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ws = new WebSocket(indexerWsUrl(indexerUrl), 'graphql-transport-ws');

  return new Promise<FirstActivity | null>((resolve, reject) => {
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
      () => finish(() => reject(new Error(`Timed out after ${timeoutMs}ms asking the indexer for first activity`))),
      timeoutMs,
    );

    ws.onopen = () => ws.send(JSON.stringify({type: 'connection_init'}));

    ws.onerror = () => finish(() => reject(new Error('Could not reach the indexer subscription endpoint')));

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
            payload: {query: QUERY, variables: {address}},
          }),
        );
        return;
      }

      if (msg.type === 'next') {
        const event = (msg.payload as {data?: {unshieldedTransactions?: Record<string, unknown>}} | undefined)?.data
          ?.unshieldedTransactions;
        if (!event) return;

        // The progress event carries the highest transaction id FOR THIS
        // ADDRESS, and it arrives first. Zero means the address has never been
        // seen — the only definitive "no history" signal there is, because the
        // subscription stays open waiting for future transactions and never
        // completes on its own. Verified against preprod: an unused address
        // yields highestTransactionId 0 in ~0.5s and then nothing.
        if (event.__typename === 'UnshieldedTransactionsProgress') {
          if (event.highestTransactionId === 0) finish(() => resolve(null));
          return;
        }

        if (event.__typename !== 'UnshieldedTransaction') return;
        const tx = event.transaction as
          | {id?: number; hash?: string; block?: {height?: number; timestamp?: number}}
          | undefined;
        const height = tx?.block?.height;
        if (typeof height !== 'number') return;
        finish(() =>
          resolve({
            height,
            timestamp: tx?.block?.timestamp ?? 0,
            transactionId: tx?.id ?? 0,
            hash: tx?.hash ?? '',
          }),
        );
        return;
      }

      if (msg.type === 'error') {
        finish(() => reject(new Error(`Indexer rejected the subscription: ${JSON.stringify(msg.payload)}`)));
        return;
      }

      // `complete` with no transaction seen means the address has no history.
      if (msg.type === 'complete') finish(() => resolve(null));
    };

    // Closing before an answer is a failure, never "no history": treating it as
    // an empty result would hand back the chain tip as a birthday and silently
    // skip the wallet's real history.
    ws.onclose = () => finish(() => reject(new Error('Indexer subscription closed before answering')));
  });
}
