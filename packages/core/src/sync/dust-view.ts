// Is the local dust view whole? Comparing what the wallet holds with what the
// chain says it should hold.
//
// The dust wallet's state is incremental and forward-only: events are applied as
// they arrive and nothing ever re-derives from the chain. So a confirmation that
// never arrives, a batch the tree rejects, or a cache seeded past the wallet's
// own history each leave a hole that `dustSynced: true` does not show. Preprod,
// 2026-09-20 → 22: a wallet paying contract fees lost sight of a ≈500 DUST coin
// for three hours, reported synced throughout, and every fee failed with
// "could not balance dust" until the coin came back by itself.
//
// This module is the pure half of the check. It is WASM-free and takes plain
// data, so it can be tested without a ledger; wallet-sync gathers the inputs
// (the indexer's generation entries and tip, the local coins and cursor) and
// acts on the verdict.

import type {DustGenerationEntry} from './dust-generations.js';

/** A dust coin as the local ledger state holds it. */
export interface LocalDustCoin {
  /** The backing NIGHT UTXO's initial nonce (hex): ties the coin to its generation entry. */
  readonly backingNight: string;
  /** False when the state has the coin but no generation entry for it — the SDK then drops it from balance and fee selection. */
  readonly hasGenerationInfo: boolean;
  /** How many times this coin's chain has been spent. */
  readonly seq: number;
  readonly ctimeMs: number;
  readonly initialValue: bigint;
}

/** A live generation entry the wallet holds no coin for. */
export interface DustViewMissing {
  readonly generationMtIndex: number;
  /** Backing NIGHT, in STAR. */
  readonly night: bigint;
  readonly backingNight: string;
  /** When the entry started generating, epoch ms. */
  readonly generatingSinceMs: number;
  /** When this check first saw the coin absent, epoch ms. */
  readonly missingSinceMs: number;
}

/**
 * What the last attempt to compare the view with the chain established.
 *
 * - `unchecked`: no attempt yet (a session that just started).
 * - `complete` / `incomplete`: the indexer answered and this is the verdict.
 * - `unknown`: the last attempt failed. The previous verdict is kept below for
 *   context but is NOT in force — an indexer outage must neither pin a wallet
 *   on a stale "incomplete" nor certify a broken view as whole.
 */
export type DustViewStatus = 'unchecked' | 'complete' | 'incomplete' | 'unknown';

export interface DustViewHealth {
  readonly status: DustViewStatus;
  /** When the indexer was last consulted (successfully or not), epoch ms. Null until the first attempt. */
  readonly checkedAt: number | null;
  /** When the indexer last answered and produced a verdict, epoch ms. */
  readonly verdictAt: number | null;
  /** True only when a check answered and found nothing wrong. False for unchecked and unknown too. */
  readonly complete: boolean;
  /** Why the last attempt could not decide, when `status` is `unknown`. */
  readonly lastError: string | null;
  /** Live generation entries with no coin in the local view. Counts against `complete` only once older than the grace. */
  readonly missing: readonly DustViewMissing[];
  /** Local coins the SDK excludes for lack of generation info. */
  readonly excluded: number;
  /** The wallet's dust cursor at the check. */
  readonly localApplied: number | null;
  /** The indexer's highest dust event id at the check. */
  readonly indexerMaxId: number | null;
  /** Events the indexer has that the wallet has not applied. */
  readonly behindBy: number | null;
  /** The cursor has not moved between two checks while the indexer's has. */
  readonly stalled: boolean;
  /** The ledger tree rejected a replay: the cache cannot recover on retry. */
  readonly inconsistent: boolean;
  /** Submitted transactions never seen on chain within the window, whose dust spends were reverted. */
  readonly revertedSubmissions: number;
  /** Live entries the indexer reported, for context. */
  readonly liveEntries: number | null;
  /** Why the view is not complete, or why the last check could not decide. */
  readonly reason: string | null;
}

export const EMPTY_DUST_VIEW: DustViewHealth = {
  status: 'unchecked',
  checkedAt: null,
  verdictAt: null,
  complete: false,
  lastError: null,
  missing: [],
  excluded: 0,
  localApplied: null,
  indexerMaxId: null,
  behindBy: null,
  stalled: false,
  inconsistent: false,
  revertedSubmissions: 0,
  liveEntries: null,
  reason: null,
};

/**
 * How long a live entry may go without a coin before the view is called
 * incomplete. A coin the wallet has just spent is hidden until its confirmation
 * event is applied — normally seconds — while a spend whose transaction never
 * landed hides it for the ledger's three-hour grace period. Ten minutes tells
 * those apart without flagging the normal case.
 */
export const DEFAULT_MISSING_GRACE_MS = 10 * 60_000;

export interface AssessInput {
  readonly now: number;
  /** Live generation entries for the wallet's dust address (dtime unset). */
  readonly live: readonly DustGenerationEntry[];
  /** Coins in the local state, hidden pending spends excluded (the ledger hides them). */
  readonly localCoins: readonly LocalDustCoin[];
  readonly localApplied: number | null;
  readonly indexerMaxId: number | null;
  readonly previous?: DustViewHealth;
  readonly missingGraceMs?: number;
  readonly inconsistent?: boolean;
  readonly revertedSubmissions?: number;
}

function formatNight(star: bigint): string {
  const whole = star / 1_000_000n;
  const frac = star % 1_000_000n;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

/**
 * Compare the local view with the chain's record and say whether it is whole.
 *
 * Pure: the previous verdict carries the first-seen time of each missing entry
 * and the cursor from last time, which is how a hidden coin becomes a missing
 * one and a slow cursor becomes a stalled one.
 */
export function assessDustView(input: AssessInput): DustViewHealth {
  const {now, live, localCoins, localApplied, indexerMaxId, previous} = input;
  const grace = input.missingGraceMs ?? DEFAULT_MISSING_GRACE_MS;
  const inconsistent = input.inconsistent ?? previous?.inconsistent ?? false;
  const revertedSubmissions = input.revertedSubmissions ?? previous?.revertedSubmissions ?? 0;

  const held = new Set(localCoins.map((c) => c.backingNight));
  const firstSeen = new Map((previous?.missing ?? []).map((m) => [m.generationMtIndex, m.missingSinceMs]));
  const missing: DustViewMissing[] = live
    .filter((e) => !held.has(e.backingNight))
    .map((e) => ({
      generationMtIndex: e.generationMtIndex,
      night: e.night,
      backingNight: e.backingNight,
      generatingSinceMs: e.ctimeMs,
      missingSinceMs: firstSeen.get(e.generationMtIndex) ?? now,
    }));
  const overdue = missing.filter((m) => now - m.missingSinceMs >= grace);

  const excluded = localCoins.filter((c) => !c.hasGenerationInfo).length;

  const behindBy =
    localApplied !== null && indexerMaxId !== null ? Math.max(0, indexerMaxId - localApplied) : null;
  // One check behind is a wallet catching up; two checks behind with the same
  // cursor is a subscription that has stopped delivering.
  const stalled =
    behindBy !== null &&
    behindBy > 0 &&
    previous?.localApplied !== undefined &&
    previous.localApplied !== null &&
    previous.localApplied === localApplied &&
    (previous.behindBy ?? 0) > 0;

  const reasons: string[] = [];
  if (inconsistent) reasons.push('the ledger rejected a replay; this dust cache cannot recover on retry');
  if (excluded > 0) reasons.push(`${excluded} coin(s) have no generation record and are excluded from the balance`);
  if (overdue.length > 0) {
    const night = overdue.reduce((s, m) => s + m.night, 0n);
    reasons.push(
      `${overdue.length} live generation entr${overdue.length === 1 ? 'y' : 'ies'} backing ${formatNight(night)} NIGHT have no coin in the local view`,
    );
  }
  if (stalled) reasons.push(`dust cursor stuck at ${localApplied} while the indexer is at ${indexerMaxId}`);
  const complete = reasons.length === 0;

  return {
    status: complete ? 'complete' : 'incomplete',
    checkedAt: now,
    verdictAt: now,
    complete,
    lastError: null,
    missing,
    excluded,
    localApplied,
    indexerMaxId,
    behindBy,
    stalled,
    inconsistent,
    revertedSubmissions,
    liveEntries: live.length,
    reason: complete ? null : reasons.join('; '),
  };
}

/** The shape of the ledger's DustLocalState this module reads, kept structural so it needs no WASM import. */
export interface DustLocalStateLike {
  readonly utxos: ReadonlyArray<{
    readonly backingNight: string;
    readonly seq: number;
    readonly ctime: Date;
    readonly initialValue: bigint;
  }>;
  generationInfo(utxo: DustLocalStateLike['utxos'][number]): unknown;
}

/** Read the local coins out of a dust ledger state. Never throws: an unreadable state reads as no coins. */
export function localDustCoins(state: DustLocalStateLike | null | undefined): LocalDustCoin[] {
  if (!state) return [];
  try {
    return state.utxos.map((u) => ({
      backingNight: String(u.backingNight),
      hasGenerationInfo: state.generationInfo(u) !== undefined,
      seq: Number(u.seq),
      ctimeMs: u.ctime instanceof Date ? u.ctime.getTime() : Number(u.ctime),
      initialValue: BigInt(u.initialValue),
    }));
  } catch {
    return [];
  }
}

/** Mark the view inconsistent (the loud failure) without waiting for a check. */
export function markInconsistent(health: DustViewHealth, reason: string): DustViewHealth {
  return {
    ...health,
    status: 'incomplete',
    complete: false,
    inconsistent: true,
    reason: health.reason && health.status === 'incomplete' ? `${reason}; ${health.reason}` : reason,
  };
}

/** Count a reverted submission on the health record. */
export function countRevertedSubmission(health: DustViewHealth): DustViewHealth {
  return {...health, revertedSubmissions: health.revertedSubmissions + 1};
}

/**
 * Record a check that could not be completed.
 *
 * The verdict becomes `unknown`: the previous findings stay on the record for
 * context, but nothing is in force. Preprod, 2026-09-23 03:41–03:47Z: the
 * indexer answered 403/503 for six minutes, a wallet's coins had come back in
 * the meantime, and the last successful check's "incomplete" kept it idle
 * holding 1,459 DUST — while on another wallet the same code path reported
 * `complete: true` with a coin fifteen minutes missing, because the failed
 * attempt kept a verdict from before the grace had run out.
 */
export function markCheckFailed(health: DustViewHealth, now: number, reason: string): DustViewHealth {
  return {
    ...health,
    status: health.inconsistent ? 'incomplete' : 'unknown',
    complete: false,
    checkedAt: now,
    lastError: reason,
    reason: health.inconsistent ? health.reason : `could not check the view: ${reason}`,
  };
}

/** How long a verdict stays in force without a fresh answer from the indexer. */
export const DEFAULT_VERDICT_MAX_AGE_MS = 15 * 60_000;

/**
 * Fold a session's view health and one emission's local fact into the verdict
 * a balance snapshot carries, and say whether `dustSynced` must be withheld.
 *
 * Only a current `incomplete` verdict withholds `dustSynced`. A verdict older
 * than `maxAgeMs` without a fresh answer is treated as unknown, so a wallet
 * cannot be pinned by a check that has stopped succeeding. Coins the SDK
 * excludes for lack of a generation record are a local fact and count at once.
 * An inconsistency (the ledger rejected a replay) is a local fact too.
 */
export function mergeDustView(
  session: DustViewHealth,
  excluded: number,
  now: number,
  maxAgeMs = DEFAULT_VERDICT_MAX_AGE_MS,
): {view: DustViewHealth; withholdSynced: boolean} {
  let view: DustViewHealth = {...session, excluded};
  const stale =
    (view.status === 'incomplete' || view.status === 'complete') &&
    view.verdictAt !== null &&
    now - view.verdictAt > maxAgeMs &&
    !view.inconsistent;
  if (stale) {
    view = {
      ...view,
      status: 'unknown',
      complete: false,
      reason: `verdict from ${new Date(view.verdictAt!).toISOString()} is stale; the indexer has not answered since`,
    };
  }
  if (excluded > 0) {
    const note = `${excluded} coin(s) have no generation record and are excluded from the balance`;
    view = {
      ...view,
      status: 'incomplete',
      complete: false,
      reason: view.status === 'incomplete' && view.reason ? `${view.reason}; ${note}` : note,
    };
  }
  return {view, withholdSynced: view.status === 'incomplete'};
}
