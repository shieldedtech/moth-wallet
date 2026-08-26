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

/**
 * What a sub-wallet's counters actually tell us.
 *
 * `{applied: 0, total: 0}` is ambiguous and was read as "complete" everywhere,
 * which is right for one case and badly wrong for the other:
 *
 *  - an EMPTY stream — a wallet that has never held a shielded coin has no
 *    shielded events, so there is nothing to apply and it is genuinely done;
 *  - a part that has NOT REPORTED yet — it restored megabytes of cached state
 *    and simply has not emitted progress in this session.
 *
 * Observed: a wallet whose dust cache sat at 1,378,733 of 1,454,764 events
 * reported `{0, 0}` on its first emissions, so every surface displayed
 * "dust 100%" while dust was 76,031 events behind, and the overall figure named
 * `shielded` as the constraint purely by tie-break.
 *
 * Restored history is what separates them: a part with a cached cursor cannot be
 * an empty stream.
 */
export type PartState = 'complete' | 'behind' | 'unreported';

/** Per-part flags a caller can supply; a part omitted is treated as historyless. */
export interface PartHistory {
  readonly shielded?: boolean;
  readonly unshielded?: boolean;
  readonly dust?: boolean;
}

/**
 * Classify one sub-wallet.
 *
 * `done` is the SDK's own verdict (`isStrictlyComplete()`) and always wins: it
 * knows about events in flight that the counters do not.
 */
export function partState(
  sub: SubProgressSnapshot,
  done: boolean,
  hasHistory = false,
): PartState {
  if (done) return 'complete';
  if (sub.total > 0) return sub.applied >= sub.total ? 'complete' : 'behind';
  return hasHistory ? 'unreported' : 'complete';
}

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
   * Which parts restored cached state this session, so `{0, 0}` from them reads
   * as "has not reported" rather than "empty". Omitted = treat all as fresh,
   * which is the pre-existing behaviour.
   */
  history?: PartHistory;
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

  const history = input.history ?? {};
  const parts: Array<{sub: SubWallet; value: number; state: PartState}> = [
    {
      sub: 'shielded',
      value: fraction(input.shielded, input.shieldedSynced),
      state: partState(input.shielded, input.shieldedSynced, history.shielded),
    },
    {
      sub: 'unshielded',
      value: fraction(input.unshielded, input.unshieldedSynced),
      state: partState(input.unshielded, input.unshieldedSynced, history.unshielded),
    },
    {
      sub: 'dust',
      value: fraction(input.dust, input.dustSynced),
      state: partState(input.dust, input.dustSynced, history.dust),
    },
  ];

  const behind = parts.filter((p) => p.state === 'behind');
  const unreported = parts.filter((p) => p.state === 'unreported');

  let percentage: number;
  let slowest: SubWallet | null;

  if (behind.length > 0) {
    // Ties resolve to the earlier entry, so a fresh wallet where everything sits
    // at 0 reports 'shielded' rather than an arbitrary one.
    const binding = behind.reduce((a, b) => (b.value < a.value ? b : a));
    percentage = binding.value;
    slowest = binding.sub;
    // Never round up to 100% while not synced: rendering a near-complete
    // fraction as "100% (0s remaining)" is the specific lie this function
    // exists to remove.
    if (percentage >= 0.995) percentage = 0.99;
  } else if (unreported.length > 0) {
    // Everything that has spoken is finished, but a part with cached history has
    // not spoken at all — so completion is unknown, not reached. Naming that part
    // beats the old behaviour, which reported 99% and blamed whichever part won
    // the tie-break: a line reading "syncing 99% (shielded) — shielded 100%,
    // unshielded 100%, dust 100%" that could never advance, because nothing was
    // outstanding to advance.
    percentage = 0.99;
    slowest = unreported[0]!.sub;
  } else {
    // Every part complete, while the facade's aggregate verdict has not caught up
    // (it never does for an empty stream). Reporting 1 here is what stops the
    // clamp below pinning a genuine 100% at 99% forever.
    percentage = 1;
    slowest = null;
  }

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

/**
 * Whether every sub-wallet stream has nothing left to apply.
 *
 * This exists because `WalletBalances.synced` — the facade's own verdict, built
 * from each sub-wallet's `isStrictlyComplete()` — never becomes true for a stream
 * that is EMPTY. A wallet that has never held a shielded coin has no shielded
 * events at all, so `isStrictlyComplete()` stays false forever and every caller
 * that waits for `synced` waits out its whole timeout: five minutes for
 * `moth balance`, and a hard rejection in the extension's `waitForSyncedBalances`.
 * The data is right within seconds; only the verdict is missing.
 *
 * The display side already takes the other view — `subPct()` in wallet-sync.ts
 * renders `total === 0` as 100% — so before this, the progress line said 100%
 * while the gate that read the same numbers said "not yet", forever. This is the
 * one definition both should use.
 *
 * An empty stream is finished, not pending: there is nothing to apply.
 *
 * The subtlety is start-up, when every stream is briefly `{applied: 0, total: 0}`
 * because nothing has been reported yet — indistinguishable, field by field, from
 * three genuinely empty streams. So completion also requires at least one stream
 * to have positively reported it: a wallet that has merely not heard from the
 * indexer yet has no such stream and is correctly judged unfinished. Deliberately
 * NOT gated on the overall percentage, which reads 100% for empty streams and so
 * cannot tell the two cases apart either.
 */
export function allStreamsComplete(input: {
  shielded: SubProgressSnapshot;
  unshielded: SubProgressSnapshot;
  dust: SubProgressSnapshot;
  shieldedSynced: boolean;
  unshieldedSynced: boolean;
  dustSynced: boolean;
  /**
   * Parts that restored cached state this session. Without this, a part sitting
   * at `{0, 0}` because it has not reported yet is indistinguishable from an
   * empty stream — and treating it as finished resolves the wait early and
   * reports a balance that is missing everything that part has yet to apply.
   * Measured: a dust cache at 1,378,733 of 1,454,764 events read as complete.
   */
  history?: PartHistory;
}): boolean {
  const history = input.history ?? {};
  const streams: ReadonlyArray<readonly [SubProgressSnapshot, boolean, boolean | undefined]> = [
    [input.shielded, input.shieldedSynced, history.shielded],
    [input.unshielded, input.unshieldedSynced, history.unshielded],
    [input.dust, input.dustSynced, history.dust],
  ];

  // Nothing outstanding anywhere: every part complete, counting an empty stream
  // as complete but never a part that simply has not spoken.
  if (!streams.every(([sub, strict, hist]) => partState(sub, strict, hist) === 'complete')) return false;

  // …and at least one stream actually said so, rather than simply not having
  // spoken yet. Note a NON-empty stream needs its own verdict: an explicit
  // `isStrictlyComplete() === false` is never overridden by `applied >= total`,
  // because the SDK knows things the counters do not (a lagging
  // highestRelevantWalletIndex, events still in flight) and resolving early here
  // would hand a caller a balance to spend from.
  return streams.some(([, strict]) => strict);
}
