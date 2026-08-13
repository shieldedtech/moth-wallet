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

/** Narrowing helper for callers holding the wider WalletPart union. */
export function isSeedablePart(part: WalletPart): part is SeedablePart {
  return (SEEDABLE_PARTS as readonly string[]).includes(part);
}
