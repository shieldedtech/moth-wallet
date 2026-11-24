// Overall sync progress, derived from the three sub-wallets' indices.
//
// WASM-free on purpose: wallet-sync.ts imports the ledger and the wallet SDK, so
// keeping this arithmetic in its own module lets it be unit-tested without
// loading WASM — the same split as types/tokens.ts and the extension's
// dust-heal.ts.

export interface SubProgressSnapshot {
  /** Events/indices applied so far. */
  applied: number;
  /** Events/indices the chain currently has for this sub-wallet. */
  total: number;
}

/** How far a DUST projections pass has resolved the wallet's coins, in blocks. */
export interface DustPassPosition {
  /** Every spend of the wallet's coins below this block is accounted for. */
  resolvedThrough: number;
  /** The block the pass is syncing to. */
  tip: number;
}

/**
 * DUST progress for display: what the wallet reported, or the pass's position
 * while it has reported no total. A projections pass applies nothing until it
 * ends, so until then the position is the only measure of how far it has got.
 */
export function dustProgressFor(reported: SubProgressSnapshot, position: DustPassPosition | null): SubProgressSnapshot {
  if (reported.total > 0 || position === null || position.tip <= 0) return reported;
  return {applied: Math.max(0, Math.min(position.resolvedThrough, position.tip)), total: position.tip};
}

/** Which sub-wallet the reported percentage belongs to. */
export type SubWallet = 'shielded' | 'unshielded' | 'dust';

export interface OverallProgressInput {
  shielded: SubProgressSnapshot;
  unshielded: SubProgressSnapshot;
  dust: SubProgressSnapshot;
  shieldedSynced: boolean;
  unshieldedSynced: boolean;
  dustSynced: boolean;
  /** The facade's own verdict: every sub-wallet strictly complete. */
  synced: boolean;
  /** Time since this sync started, for the ETA. 0 disables the estimate. */
  elapsedMs: number;
  /**
   * Where this session actually began: the slowest sub-wallet's fraction when it
   * started (`slowestFraction`), and the elapsed reading at that moment.
   *
   * Without it the ETA assumes the sync began at 0% when the process began,
   * which is false for every resumed sync — and dust resumes constantly. A run
   * that restored a cache at 65% and then ran for 152s was read as "67% in 152s",
   * a rate 15x too fast, so the estimate came out 4-5x short and CLIMBED as
   * elapsed time slowly corrected the fiction. Measured on preprod: 1m15s
   * predicted at 67%, 2m23s at 81%, against a true ~10m.
   */
  baseline?: {readonly fraction: number; readonly elapsedMs: number};
}

/**
 * Progress is the average of the sub-wallets still syncing, so the figure moves
 * as each of them does; the time estimate comes from the slowest, which is the
 * one the wallet waits for.
 *
 * Taking the slowest alone read 0% and then 100% on a pre-seeded wallet, whose
 * DUST pass reports nothing until it ends while shielded catches up visibly.
 */
export function overallSyncProgress(input: OverallProgressInput): {
  percentage: number;
  etaSeconds: number | null;
  /**
   * The sub-wallet the estimate is waiting on — the slowest one, and null once
   * everything is synced. Named in the progress log, so that "syncing 27%" beside
   * shielded and unshielded at 100% reads as dust being the constraint.
   */
  slowest: SubWallet | null;
  /** The slowest sub-wallet's own fraction: what the estimate and its baseline measure. */
  slowestFraction: number;
} {
  if (input.synced) return { percentage: 1, etaSeconds: 0, slowest: null, slowestFraction: 1 };

  // 0/0 is complete only once the sub-wallet says so: a fresh wallet's empty
  // unshielded side is, but every part reads 0/0 before it has connected, and
  // counting that as complete showed 99% before the sync had started.
  const part = (sub: SubWallet, progress: SubProgressSnapshot, done: boolean) => ({
    sub,
    value: done ? 1 : progress.total > 0 ? Math.min(1, progress.applied / progress.total) : 0,
    // Finished with nothing to sync: left out of the average rather than handed a share of it.
    idle: done && progress.total === 0,
  });
  const parts = [
    part('shielded', input.shielded, input.shieldedSynced),
    part('unshielded', input.unshielded, input.unshieldedSynced),
    part('dust', input.dust, input.dustSynced),
  ];
  // Ties resolve to the earlier entry, so a fresh wallet where everything sits
  // at 0 reports 'shielded' rather than an arbitrary one.
  const binding = parts.reduce((a, b) => (b.value < a.value ? b : a));
  const slowest = binding.sub;

  const syncing = parts.filter((p) => !p.idle);
  let percentage = syncing.length > 0 ? syncing.reduce((sum, p) => sum + p.value, 0) / syncing.length : 1;

  // Never round up to 100% while not synced: rendering a near-complete fraction
  // as "100% (0s remaining)" is the specific lie this function exists to remove.
  if (percentage >= 0.995) percentage = 0.99;
  const pace = binding.value >= 0.995 ? 0.99 : binding.value;

  // ETA against the slowest sub-wallet, not the average, so it does not promise
  // the pace of one that finished a minute in.
  //
  // Rate comes from progress made THIS session, not from cumulative progress
  // over session elapsed — see the note on `baseline`. Both forms are kept
  // because a sync that genuinely starts at zero has no baseline to measure
  // from until its second sample.
  let etaSeconds: number | null = null;
  const b = input.baseline;
  if (b && input.elapsedMs > b.elapsedMs && pace > b.fraction) {
    // Enough movement to divide by. Below that the rate is noise and a number
    // derived from it is worse than admitting the estimate is not ready.
    const advanced = pace - b.fraction;
    const overMs = input.elapsedMs - b.elapsedMs;
    if (advanced >= 0.002 && overMs >= 1_000) {
      const remaining = Math.max(0, 1 - pace);
      etaSeconds = Math.max(0, Math.round((remaining * overMs) / advanced / 1000));
    }
  } else if (!b && input.elapsedMs > 0 && pace > 0.01) {
    const totalEstMs = input.elapsedMs / pace;
    etaSeconds = Math.max(0, Math.round((totalEstMs - input.elapsedMs) / 1000));
  }

  return { percentage, etaSeconds, slowest, slowestFraction: pace };
}
