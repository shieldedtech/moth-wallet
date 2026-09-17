// Which sub-wallet caches a pre-seed should fill in.
//
// Split out and WASM-free so the decision is unit-testable without loading the
// ledger — the same split as sync/progress.ts.
//
// This exists because the decision was once made by proxy: the pre-seed gate
// tested the SHIELDED cache alone, standing in for "this wallet has no state
// yet". That proxy failed exactly where it mattered. A DUST rebuild evicts the
// dust cache and nothing else, so shielded was still present, the gate stayed
// shut, and dust walked all 1.4M events from genesis — 78.6 min on preprod —
// while a usable reference sat unused.

import type {WalletPart} from './sync-store.js';

/** The parts a pre-seed can supply. History is not seeded; it rebuilds itself. */
export const SEEDABLE_PARTS = ['shielded', 'unshielded', 'dust'] as const;

export type SeedablePart = (typeof SEEDABLE_PARTS)[number];

/**
 * The seedable parts with no cached state, in a fixed order.
 *
 * A part that already has a cache is at least as far along as the reference, so
 * seeding over it would discard progress. Anything absent is a candidate,
 * whether this is a brand-new wallet (all three) or a rebuild of one
 * (just the evicted part).
 */
export function partsToSeed(cached: Partial<Record<SeedablePart, string | null>>): SeedablePart[] {
  return SEEDABLE_PARTS.filter((part) => !cached[part]);
}

/** Whether a pre-seed attempt is worth making at all. */
export function shouldAttemptPreSeed(cached: Partial<Record<SeedablePart, string | null>>): boolean {
  return partsToSeed(cached).length > 0;
}

/** The reference holds the chain at its height; a birthday at or after it proves the wallet has no earlier history. */
export function birthdayAdmits(birthday: number | undefined, referenceHeight: number): boolean {
  return birthday !== undefined && referenceHeight <= birthday;
}

/** What a dust-history probe (sync/dust-history.ts) found at or below the reference height. */
export type DustHistoryVerdict =
  | {kind: 'none'}
  | {kind: 'some'; entries: number}
  | {kind: 'unknown'; reason: string};

export type PreSeedPlan =
  | {kind: 'all'; parts: SeedablePart[]}
  | {kind: 'dust-only'}
  | {kind: 'none'; reason: string};

/**
 * Which missing parts a reference may seed. A birthday proves every part safe. Without
 * one, only dust can be proven safe — all of a wallet's DUST descends from generation
 * entries owned by its dust key, so none at the reference height means no history to lose.
 */
export function preSeedPlan(input: {
  missing: SeedablePart[];
  birthday: number | undefined;
  referenceHeight: number;
  dustHistory: DustHistoryVerdict | null;
}): PreSeedPlan {
  const {missing, birthday, referenceHeight, dustHistory} = input;
  if (missing.length === 0) return {kind: 'none', reason: 'nothing to seed, every sub-wallet already cached'};
  if (birthdayAdmits(birthday, referenceHeight)) return {kind: 'all', parts: missing};

  const birthdayReason =
    birthday === undefined
      ? 'no wallet birthday to compare'
      : `reference is newer than this wallet (height ${referenceHeight} > birthday ${birthday})`;
  if (!missing.includes('dust')) return {kind: 'none', reason: `${birthdayReason} — syncing from genesis`};

  switch (dustHistory?.kind) {
    case 'none':
      return {kind: 'dust-only'};
    case 'some':
      return {
        kind: 'none',
        reason: `this account has DUST history before the reference (height ${referenceHeight}) — syncing dust from genesis`,
      };
    case 'unknown':
      return {kind: 'none', reason: `${birthdayReason}; could not confirm DUST history (${dustHistory.reason}) — syncing from genesis`};
    default:
      return {kind: 'none', reason: `${birthdayReason} — syncing from genesis`};
  }
}

/** Narrowing helper for callers holding the wider WalletPart union. */
export function isSeedablePart(part: WalletPart): part is SeedablePart {
  return (SEEDABLE_PARTS as readonly string[]).includes(part);
}
