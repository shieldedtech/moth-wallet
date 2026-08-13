// Policy for the automatic dust-view repair. The chain registers NIGHT at the
// key level and generates DUST regardless of what the wallet displays; what
// can go stale is the LOCAL dust view, restored from its serialized cache and
// occasionally missing generation records for NIGHT UTXOs created after the
// checkpoint. The repair is transaction-free: evict only the dust sub-wallet's
// cache and let it rescan (see wallet-host.ts). Pure and unit-tested here;
// wiring lives with the sync engine.

import type { WalletBalances } from '@shieldedtech/moth-browser';

/** The ledger's dust grace period is 3h — records for fresh UTXOs may
 *  legitimately take that long. Only past this (grace + margin) is a missing
 *  record considered a stale view. */
export const DUST_VIEW_STALE_AFTER_MS = 4 * 3_600_000;

/** Repairs cost a dust rescan — never run them back to back. */
export const DUST_HEAL_COOLDOWN_MS = 6 * 3_600_000;

/** Sync-store key remembering the last repair per wallet + network. */
export function dustHealKey(networkId: string, walletName: string): string {
  return `dust-heal/${networkId}/${walletName}`;
}

/**
 * True when the dust view looks stale enough to rebuild: fully synced, yet
 * registered NIGHT old enough that its generation records must exist is still
 * missing from the local capacity.
 */
export function shouldRepairDustView(
  balances: WalletBalances,
  now: number,
  lastHealAt: number | null,
  lastSubmittedAt: number | null = null,
): boolean {
  const generation = balances.dustGeneration;
  if (!balances.syncProgress.dustSynced || !generation?.registered) return false;
  // A DUST spend in flight moves its coin out of availableCoins, so `designated`
  // (derived from the maxCap of AVAILABLE coins) collapses while registeredNight
  // stays. That deficit is expected settling, not a stale view — and a fee-only
  // spend leaves the NIGHT UTXOs untouched, so their old ctime would otherwise
  // sail straight through the staleness gate below.
  if (balances.coins?.dust?.pending?.length) return false;
  // No deficit — every registered STAR is backed by a generation record.
  if (generation.registeredNight <= generation.designated) return false;
  // Records for recent UTXOs may still be settling (grace period).
  const newest = generation.newestRegisteredAt;
  if (!newest || now - newest.getTime() < DUST_VIEW_STALE_AFTER_MS) return false;
  // Same reasoning one step later: once the spend's coins have left `pending`,
  // a recent transaction still explains the deficit (DUST spent on fees, fresh
  // NIGHT awaiting its record). Only a deficit outliving the grace period is
  // evidence of a genuinely stale cache.
  if (lastSubmittedAt !== null && now - lastSubmittedAt < DUST_VIEW_STALE_AFTER_MS) return false;
  return lastHealAt === null || now - lastHealAt >= DUST_HEAL_COOLDOWN_MS;
}
