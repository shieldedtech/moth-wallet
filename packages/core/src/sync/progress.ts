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

/** How far back the rate looks. Three minutes: the DUST walk's pace drifts
 *  over a sync, and a shorter window followed every wobble into the display. */
export const RATE_WINDOW_MS = 180_000;
/** Progress is measured over bins this long; a sub-wallet's events arrive in
 *  lumps, so the second-to-second rate is mostly zeros and spikes. */
const RATE_BIN_MS = 30_000;
/** Estimates are stretched by this before they become the deadline, so a
 *  pace that slows later still finishes inside what was promised. */
const PESSIMISM = 1.5;
/** A fresh estimate pushes the deadline LATER only when it exceeds the time
 *  still shown by this factor plus slack, and has done so for the hold time. */
const RAISE_FACTOR = 1.5;
const RAISE_SLACK_MS = 30_000;
const RAISE_HOLD_MS = 30_000;
/** From here on the walk is at the chain tip, where events arrive at block
 *  pace: the measured rate collapses, but nothing is being replayed. */
const TIP_FRACTION = 0.98;

/**
 * The samples the ETA is measured over, and the deadline it counts down to.
 *
 * The rate used to be measured from the session's first sample, which reads
 * the whole run as one rate — and a replay has no one rate. A sub-wallet is
 * starved while another replays beside it: on mainnet the DUST walk ran at
 * ~25 events/s until the shielded walk finished, then at ~1,500/s, so an
 * estimate made at 1% promised "3h 19m" of a sync that ended seven minutes
 * later. Hence a sliding window, emptied whenever the set of sub-wallets still
 * replaying changes, since that is where the rate jumps.
 *
 * Within a phase the pace is uneven too: the DUST walk arrives in bursts (one
 * 30s span on mainnet carried five times the events of its neighbours) and
 * then slows by half over the phase, and the slope between a window's
 * endpoints followed both into the display, which read 3 min, 2, 1, then 2
 * and 3 again while the bar barely moved. A countdown is only believable if
 * it counts down, so three rules make it pessimistic and then monotone. The
 * rate is the SLOWEST 30-second bin in the window, so a burst cannot speed
 * the estimate up. The estimate is stretched by a margin before it becomes
 * the deadline, so a pace that slows later still finishes inside it. And the
 * deadline only moves earlier freely: it moves later only when the raw
 * estimate exceeds the time still shown by a wide margin, and has done so
 * for a while. On the mainnet trace this shows 282s where 273 remained and
 * 38s where 33 did, never rising in between.
 *
 * Measuring from samples rather than from the session start is also what
 * keeps a resumed sync honest: a run that restored a cache at 65% and ran for
 * 152s was once read as "67% in 152s", 15x the real rate.
 */
export class ProgressRateTracker {
  private phase: string | null = null;
  private samples: ProgressSample[] = [];
  private deadlineMs: number | null = null;
  private raisePendingSinceMs: number | null = null;

  /**
   * Record a sample and return the seconds remaining to show, or null when
   * this phase has too little behind it to say.
   */
  observe(phase: string, sample: ProgressSample, windowMs = RATE_WINDOW_MS): number | null {
    if (phase !== this.phase) {
      this.phase = phase;
      this.samples = [sample];
      this.deadlineMs = null;
      this.raisePendingSinceMs = null;
      return null;
    }
    this.samples.push(sample);
    // Drop samples that have fallen out of the window, but keep the two newest
    // so a stall longer than the window still has a rate to report as slow.
    const cutoff = sample.elapsedMs - windowMs;
    while (this.samples.length > 2 && this.samples[1]!.elapsedMs <= cutoff) this.samples.shift();

    const first = this.samples[0]!;
    if (sample.elapsedMs - first.elapsedMs < RATE_BIN_MS) return this.countdown(sample.elapsedMs);
    const rate = slowestBinRate(this.samples, RATE_BIN_MS);
    // No measurable movement: keep counting down what was promised rather than
    // divide by nothing, and say nothing if nothing was promised yet.
    if (!(rate > 0)) return this.countdown(sample.elapsedMs);

    const rawMs = Math.max(0, 1 - sample.fraction) / rate;
    const candidate = sample.elapsedMs + rawMs * PESSIMISM;
    if (this.deadlineMs === null || candidate < this.deadlineMs) {
      this.deadlineMs = candidate;
      this.raisePendingSinceMs = null;
    } else if (sample.fraction >= TIP_FRACTION) {
      // At the tip the rate reads as a collapse that is not one. Keep the
      // promise counting down, and once it has run out say nothing rather
      // than announce minutes more for a walk that is waiting on blocks.
      if (this.deadlineMs - sample.elapsedMs < 1_000) return null;
    } else {
      const shownMs = this.deadlineMs - sample.elapsedMs;
      if (rawMs > shownMs * RAISE_FACTOR + RAISE_SLACK_MS) {
        this.raisePendingSinceMs ??= sample.elapsedMs;
        if (sample.elapsedMs - this.raisePendingSinceMs >= RAISE_HOLD_MS) {
          this.deadlineMs = candidate;
          this.raisePendingSinceMs = null;
        }
      } else {
        this.raisePendingSinceMs = null;
      }
      // A deadline that has arrived is a promise already broken; re-estimate
      // rather than show zero while the bar still moves.
      if (this.deadlineMs - sample.elapsedMs < 1_000) this.deadlineMs = candidate;
    }
    return this.countdown(sample.elapsedMs);
  }

  private countdown(elapsedMs: number): number | null {
    if (this.deadlineMs === null) return null;
    return Math.max(0, Math.round((this.deadlineMs - elapsedMs) / 1000));
  }
}

/** The fraction at `t`, interpolated between the samples around it. */
function fractionAt(samples: ReadonlyArray<ProgressSample>, t: number): number {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.elapsedMs > t) continue;
    const next = samples[i + 1];
    if (!next || next.elapsedMs === s.elapsedMs) return s.fraction;
    return s.fraction + ((t - s.elapsedMs) / (next.elapsedMs - s.elapsedMs)) * (next.fraction - s.fraction);
  }
  return samples[0]!.fraction;
}

/** The slowest rate (fraction per ms) over any whole bin in the samples, newest bin first. */
function slowestBinRate(samples: ReadonlyArray<ProgressSample>, binMs: number): number {
  const newest = samples[samples.length - 1]!.elapsedMs;
  const oldest = samples[0]!.elapsedMs;
  let slowest = Infinity;
  for (let end = newest; end - binMs >= oldest; end -= binMs) {
    const rate = (fractionAt(samples, end) - fractionAt(samples, end - binMs)) / binMs;
    if (rate < slowest) slowest = rate;
  }
  return slowest === Infinity ? 0 : slowest;
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
  // rather than one that finished a minute in. The tracker measures the rate
  // (see ProgressRateTracker); the estimate is shown only while a single
  // sub-wallet is replaying, since with two the one behind is starved by the
  // other and its rate says nothing about how fast it will run once alone.
  const replaying = fractions.filter((f) => f.value < 1).map((f) => f.sub);
  const remaining = input.rate?.observe(replaying.join('+'), { fraction: percentage, elapsedMs: input.elapsedMs }) ?? null;
  const etaSeconds = replaying.length === 1 ? remaining : null;

  return { percentage, etaSeconds, slowest };
}
