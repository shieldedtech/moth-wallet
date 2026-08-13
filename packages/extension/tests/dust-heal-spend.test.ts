// Regression: a successful transaction must not trigger the dust-view repair.
//
// Symptom it guards against: after a send, the dust bar dropped and climbed from
// near zero for 10-15 minutes, as if syncing from genesis.
//
// Cause: `designated` is derived from the maxCap of dust coins in
// state.dust.availableCoins (wallet-sync.ts:923-945). Spending a dust UTXO moves
// it out of availableCoins while it settles, so designated collapses while
// registeredNight — untouched by a fee-only spend, and keeping its old ctime —
// stays. That looked identical to the stale view the heal targets, so the heal
// ran syncStop -> clearDustSyncCache -> syncEnsure, resetting the dust
// sub-wallet's appliedIndex to 0 and forcing a full dust rescan.

import { describe, expect, it } from 'vitest';
import { DUST_VIEW_STALE_AFTER_MS, shouldRepairDustView } from '../lib/offscreen/dust-heal';
import { makeBalances } from './balances-fixture';

const NOW = Date.parse('2026-07-24T12:00:00Z');
const NIGHT = 4_424n * 10n ** 6n;
const CAP = 15_000n * 10n ** 15n;

// A DUST-fee spend does not touch the registered NIGHT UTXOs, so the newest
// registration keeps its old ctime and clears the staleness gate on its own.
const OLD = new Date(NOW - DUST_VIEW_STALE_AFTER_MS - 60_000);

/** The capacity deficit both scenarios present to the predicate. */
function deficit() {
  return makeBalances({
    night: NIGHT,
    limit: CAP,
    registered: true,
    registeredNight: NIGHT, // registered NIGHT, untouched
    generatingNight: 0n, // designated collapsed
    newestRegisteredAt: OLD,
    dustSynced: true,
  });
}

/** Balances while a spend's dust change is still pending. */
function spendSettling() {
  const balances = deficit();
  (balances.coins.dust.pending as unknown[]).push({
    generatedNow: 0n,
    maxCap: CAP,
    maxCapReachedAt: new Date(NOW + 3_600_000),
    dtime: null,
  });
  return balances;
}

describe('dust heal vs a legitimate DUST spend', () => {
  it('does not evict the dust cache while a spend is settling', () => {
    expect(shouldRepairDustView(spendSettling(), NOW, null)).toBe(false);
  });

  it('does not evict the dust cache for a recent submission', () => {
    // The spend's coins have left `pending`, but the submission log still
    // explains the deficit — DUST spent on fees, fresh NIGHT awaiting its record.
    const justSent = NOW - 60_000;
    expect(shouldRepairDustView(deficit(), NOW, null, justSent)).toBe(false);
  });

  it('distinguishes a fresh spend from the stale view it targets', () => {
    expect(shouldRepairDustView(spendSettling(), NOW, null)).toBe(false);
    expect(shouldRepairDustView(deficit(), NOW, null, null)).toBe(true);
  });

  it('still repairs once the deficit outlives the grace period', () => {
    // A submission older than the grace period no longer explains the deficit,
    // so a genuinely stale view is still rebuilt.
    const longAgo = NOW - DUST_VIEW_STALE_AFTER_MS - 60_000;
    expect(shouldRepairDustView(deficit(), NOW, null, longAgo)).toBe(true);
  });
});
