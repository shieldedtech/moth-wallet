// The facade's PendingTransactionsService releases the coins a transaction
// booked once the indexer reports it failed, partly failed or expired, or once
// a protocol upgrade strands it, but it keeps that list in memory. The
// sub-wallet states that hold the booked coins are cached, so without this the
// coins outlive a restart with nothing left to release them (#208).
//
// The list is saved in the SDK's own format: each transaction keeps the
// protocol version it was authored for, so one restored after the wallets
// cross the v9 fork is still recognised as stranded, and the reservations of
// balanced-but-unsubmitted spends come back with it.

import {
  PendingTransactions,
  PendingTransactionsServiceImpl,
  type DefaultPendingTransactionsServiceConfiguration,
  type PendingTransactionsService,
} from '@midnightntwrk/wallet-sdk/capabilities/pendingTransactions';
import {Either} from 'effect';

/** Serialize the watched transactions and reservations, or null when there is nothing to keep. */
export function serializePendingTransactions<T>(
  state: PendingTransactions.PendingTransactions<T>,
  traits: PendingTransactions.VersionedTransactionTrait<T>
): string | null {
  if (state.all.length === 0 && state.reservations.length === 0) return null;
  return PendingTransactions.serialize(state, traits);
}

/**
 * Read a saved list back, or undefined when it no longer decodes: its coins
 * then wait for a resync, as they did before the list was saved at all.
 */
export function restorePendingState<T>(
  raw: string,
  traits: PendingTransactions.VersionedTransactionTrait<T>
): PendingTransactions.PendingTransactions<T> | undefined {
  return Either.getOrUndefined(PendingTransactions.deserialize(raw, traits));
}

/**
 * The facade's pending service, seeded with the saved list so the first status
 * poll already covers it. Without a readable list this is the facade's default.
 */
export function makePendingTransactionsService<T>(
  saved: string | null,
  txTraits: PendingTransactions.VersionedTransactionTrait<T>,
  configuration: DefaultPendingTransactionsServiceConfiguration
): Promise<PendingTransactionsService<T>> {
  const initialState = saved ? restorePendingState(saved, txTraits) : undefined;
  return PendingTransactionsServiceImpl.init({configuration, txTraits, initialState});
}
