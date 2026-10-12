// The facade's PendingTransactionsService releases the coins a transaction
// booked once the indexer reports it failed, partly failed or expired, but it
// keeps that list in memory. The sub-wallet states that hold the booked coins
// are cached, so without this the coins outlive a restart with nothing left to
// release them (#208).
//
// WASM-free: the caller supplies the transaction type's (de)serializer.

interface SerializedPending {
  version: 1;
  /** Hex-encoded finalized transactions. */
  transactions: string[];
}

/** The slice of the facade's pending state this module reads. */
export interface PendingTransactionsState<T> {
  all: ReadonlyArray<{tx: T}>;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Serialize the watched transactions, or null when there are none to keep. */
export function serializePendingTransactions<T>(
  state: PendingTransactionsState<T>,
  serialize: (tx: T) => Uint8Array
): string | null {
  if (state.all.length === 0) return null;
  const payload: SerializedPending = {version: 1, transactions: state.all.map((item) => toHex(serialize(item.tx)))};
  return JSON.stringify(payload);
}

/**
 * Hand saved transactions back to the facade's pending service, which re-checks
 * each one's status and reverts it if it failed. An entry that no longer
 * decodes is skipped: its coins then wait for a resync, as before.
 * Returns how many were restored.
 */
export async function restorePendingTransactions<T>(
  raw: string,
  deserialize: (bytes: Uint8Array) => T,
  addPendingTransaction: (tx: T) => Promise<void>
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const transactions = (parsed as Partial<SerializedPending> | null)?.transactions;
  if ((parsed as Partial<SerializedPending> | null)?.version !== 1 || !Array.isArray(transactions)) return 0;

  let restored = 0;
  for (const hex of transactions) {
    const bytes = typeof hex === 'string' ? fromHex(hex) : null;
    if (!bytes) continue;
    let tx: T;
    try {
      tx = deserialize(bytes);
    } catch {
      continue;
    }
    await addPendingTransaction(tx);
    restored++;
  }
  return restored;
}
