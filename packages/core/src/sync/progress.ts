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
   * Where this session actually began: the fraction already complete when it
   * started, and the elapsed reading at that moment.
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
 * Progress is the SLOWEST sub-wallet, never the shielded one alone.
 *
 * This used to read shielded indices only, on the stated assumption that shielded
 * was the slowest. It is not — dust is, by two orders of magnitude: a full dust
 * walk is ~1.4M events at a few hundred per second, where shielded covers the same
 * range in under a minute. Observed consequence on preprod: a wallet reporting
 * "100% (0s remaining)" with dust at 178,029/1,395,558 and roughly 69 minutes of
 * work left — worse than reporting nothing, because it stops the user waiting.
 */
export function overallSyncProgress(input: OverallProgressInput): {
  percentage: number;
  etaSeconds: number | null;
  /**
   * The sub-wallet the percentage came from — the slowest one, and null once
   * everything is synced.
   *
   * Returned because reporting the minimum without saying whose it is produces
   * a genuinely confusing log: a timeline reading "syncing 27%" beside a UI
   * showing shielded and unshielded at 100% looks like a contradiction rather
   * than like dust being the constraint.
   */
  slowest: SubWallet | null;
} {
  if (input.synced) return { percentage: 1, etaSeconds: 0, slowest: null };

  // A sub-wallet with nothing relevant to apply (total 0) is complete, not
  // stalled — count it as 1 so it cannot drag the minimum to zero. A fresh
  // wallet's unshielded progress is legitimately 0/0.
  const fraction = (sub: SubProgressSnapshot, done: boolean): number => {
    if (done) return 1;
    return sub.total > 0 ? Math.min(1, sub.applied / sub.total) : 1;
  };

  const fractions: Array<{ sub: SubWallet; value: number }> = [
    { sub: 'shielded', value: fraction(input.shielded, input.shieldedSynced) },
    { sub: 'unshielded', value: fraction(input.unshielded, input.unshieldedSynced) },
    { sub: 'dust', value: fraction(input.dust, input.dustSynced) },
  ];
  // Ties resolve to the earlier entry, so a fresh wallet where everything sits
  // at 0 reports 'shielded' rather than an arbitrary one.
  const binding = fractions.reduce((a, b) => (b.value < a.value ? b : a));
  const slowest = binding.sub;

  let percentage = binding.value;

  // Never round up to 100% while not synced: rendering a near-complete fraction
  // as "100% (0s remaining)" is the specific lie this function exists to remove.
  if (percentage >= 0.995) percentage = 0.99;

  // ETA against the same fraction, so it reflects whichever sub-wallet is behind
  // rather than one that finished a minute in.
  //
  // Rate comes from progress made THIS session, not from cumulative percentage
  // over session elapsed — see the note on `baseline`. Both forms are kept
  // because a sync that genuinely starts at zero has no baseline to measure
  // from until its second sample.
  let etaSeconds: number | null = null;
  const b = input.baseline;
  if (b && input.elapsedMs > b.elapsedMs && percentage > b.fraction) {
    // Enough movement to divide by. Below that the rate is noise and a number
    // derived from it is worse than admitting the estimate is not ready.
    const advanced = percentage - b.fraction;
    const overMs = input.elapsedMs - b.elapsedMs;
    if (advanced >= 0.002 && overMs >= 1_000) {
      const remaining = Math.max(0, 1 - percentage);
      etaSeconds = Math.max(0, Math.round((remaining * overMs) / advanced / 1000));
    }
  } else if (!b && input.elapsedMs > 0 && percentage > 0.01) {
    const totalEstMs = input.elapsedMs / percentage;
    etaSeconds = Math.max(0, Math.round((totalEstMs - input.elapsedMs) / 1000));
  }

  return { percentage, etaSeconds, slowest };
}
