// The facade keeps one lifecycle record per transaction, from balancing to the
// chain's verdict, and releases a transaction's coins when its record ends
// rejected or orphaned. The records live in memory while the sub-wallet states
// holding the booked coins are cached, so without this the coins outlive a
// restart with nothing left to release them (#208).
//
// The service writes its records in the SDK's own format, and reads back the
// pending-transactions list earlier builds saved under the same cache key.

import {
  TransactionLifecycleServiceImpl,
  type DefaultTransactionLifecycleServiceConfiguration,
  type TransactionLifecycleService,
  type TransactionTraits,
  type WallClock,
} from '@midnightntwrk/wallet-sdk/capabilities/transactionLifecycle';

/**
 * The facade's lifecycle service, holding the records the last session saved, so
 * its first poll already covers them. A store that no longer reads gives a fresh
 * service: its coins then wait for a resync, as they did before it was saved.
 */
export async function makeTransactionLifecycleService<T>(
  saved: string | null,
  txTraits: TransactionTraits.VersionedTransactionTrait<T>,
  configuration: DefaultTransactionLifecycleServiceConfiguration,
  clock?: WallClock
): Promise<TransactionLifecycleService<T>> {
  if (saved) {
    try {
      return await TransactionLifecycleServiceImpl.restore(saved, txTraits, configuration, clock);
    } catch {
      /* unreadable: start fresh */
    }
  }
  return TransactionLifecycleServiceImpl.init({configuration, txTraits, clock});
}
