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
   * Recent samples the ETA's rate is measured over; without one there is no
   * estimate. Stateful by design and held per session: the daemon and TUI sync
   * several wallets in one process, and a shared tracker would hand each of
   * them the others' history.
   */
  rate?: ProgressRateTracker;
}

export interface ProgressSample {
  /** The binding sub-wallet's fraction at this emission. */
  readonly fraction: number;
  readonly elapsedMs: number;
}

/** How far back the rate looks: long enough to smooth a bursty replay, short
 *  enough that a changed rate shows within a couple of minutes. */
export const RATE_WINDOW_MS = 90_000;

/**
 * The samples the ETA's rate is measured over.
 *
 * The rate used to be measured from the session's first sample, which reads
 * the whole run as one rate — and a replay has no one rate. A sub-wallet is
 * starved while another replays beside it: on mainnet the DUST walk ran at
 * ~25 events/s until the shielded walk finished, then at ~1,500/s, so an
 * estimate made at 1% promised "3h 19m" of a sync that ended seven minutes
 * later, and shrank only as slowly as the early samples lost weight. Hence a
 * sliding window, emptied whenever the set of sub-wallets still replaying
 * changes, since that is where the rate jumps.
 *
 * Measuring from a first sample rather than from the session start is also
 * what keeps a resumed sync honest: a run that restored a cache at 65% and ran
 * for 152s was once read as "67% in 152s", 15x the real rate.
 */
export class ProgressRateTracker {
  private phase: string | null = null;
  private samples: ProgressSample[] = [];

  /**
   * Record a sample and return the one the rate should be measured from, or
   * undefined when this phase has nothing earlier to measure against.
   */
  observe(phase: string, sample: ProgressSample, windowMs = RATE_WINDOW_MS): ProgressSample | undefined {
    if (phase !== this.phase) {
      this.phase = phase;
      this.samples = [sample];
      return undefined;
    }
    this.samples.push(sample);
    // Drop samples that have fallen out of the window, but keep the two newest
    // so a stall longer than the window still has a rate to report as slow.
    const cutoff = sample.elapsedMs - windowMs;
    while (this.samples.length > 2 && this.samples[1]!.elapsedMs <= cutoff) this.samples.shift();
    return this.samples[0];
  }
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
  // rather than one that finished a minute in. The rate is measured over the
  // tracker's recent samples (see ProgressRateTracker), and only while a single
  // sub-wallet is replaying: with two, the one behind is starved by the other,
  // and its rate says nothing about how fast it will run once alone.
  const replaying = fractions.filter((f) => f.value < 1).map((f) => f.sub);
  const from = input.rate?.observe(replaying.join('+'), { fraction: percentage, elapsedMs: input.elapsedMs });
  let etaSeconds: number | null = null;
  if (from && replaying.length === 1 && input.elapsedMs > from.elapsedMs && percentage > from.fraction) {
    // Enough movement to divide by. Below that the rate is noise and a number
    // derived from it is worse than admitting the estimate is not ready.
    const advanced = percentage - from.fraction;
    const overMs = input.elapsedMs - from.elapsedMs;
    if (advanced >= 0.002 && overMs >= 5_000) {
      const remaining = Math.max(0, 1 - percentage);
      etaSeconds = Math.max(0, Math.round((remaining * overMs) / advanced / 1000));
    }
  }

  return { percentage, etaSeconds, slowest };
}
