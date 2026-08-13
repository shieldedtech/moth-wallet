// What a registration attempt actually achieved.
//
// Core's designateForDust returns a bare `null` for two unrelated situations —
// "every NIGHT UTxO is already registered" and "there were no NIGHT UTxOs
// available to register" — and the panel used to report both as the success
// screen "Already generating". That is the wallet asserting something false
// about the user's own funds.
//
// Observed on preprod while its node was refusing connections (HTTP 403): a
// registration was built and proved, submission never landed, and its NIGHT
// stayed booked. Every later attempt then found nothing AVAILABLE to register,
// returned null, and was reported as "your tNIGHT was already registered" —
// while the same screen's detail row said "Not registered".
//
// The panel already holds enough to tell the cases apart, so this is a pure
// function over data it has: whether anything is registered, and whether any
// NIGHT exists at all. WASM-free and dependency-free, so it is unit-testable.

export type RegisterOutcome =
  /** A transaction was built and submitted. */
  | 'submitted'
  /** Nothing to do: every NIGHT UTxO was already registered. */
  | 'already-registered'
  /** Nothing to do, and nothing to do it with: the wallet holds no NIGHT. */
  | 'no-night'
  /** NIGHT exists but none of it is spendable right now — typically booked by an
   *  earlier registration or send that has not settled. Reporting this as
   *  success is the bug this type exists to prevent. */
  | 'unavailable'
  /**
   * Registration cannot pay its own fee yet: it self-funds from the DUST its
   * NIGHT would already have generated, and that amount starts at zero. Nothing
   * was built, booked or spent, and the same attempt succeeds later untouched.
   *
   * Distinct from the others because it is not a defect in anything — not the
   * wallet, not the node, not the prover. Grouping it with real failures is how
   * the panel came to answer "your NIGHT is too new" with "check your proof
   * server". See core sync/dust-registration-estimate.ts.
   */
  | 'not-yet';

export function registerOutcome(input: {
  /** null when core found nothing to register. */
  txHash: string | null;
  /** Set when registration cannot pay its own fee yet. Decided before anything
   *  else: the wallet's registration state says nothing about affordability, so
   *  a wallet with unregistered NIGHT would otherwise be reported 'unavailable'
   *  — true in the letter and misleading in substance. */
  notYet?: boolean;
  /** dustGeneration.registered — is any NIGHT actually registered on-chain. */
  registered: boolean;
  /** Total NIGHT the wallet reports, which INCLUDES booked (pending) coins. */
  nightBalance: bigint;
}): RegisterOutcome {
  if (input.txHash !== null) return 'submitted';
  if (input.notYet) return 'not-yet';
  if (input.registered) return 'already-registered';
  // Nothing registered, nothing registerable. If the wallet shows no NIGHT at
  // all the user simply has none; if it shows a balance, that balance is real
  // but unavailable — the displayed figure folds in booked coins (see
  // wallet-sync's unshielded handling), which is exactly how a wallet can read
  // "10 NIGHT" while having none to register.
  return input.nightBalance > 0n ? 'unavailable' : 'no-night';
}

/** Whether the outcome should be shown as a success. `unavailable` must not be:
 *  nothing was registered and the user needs to know why. Nor `not-yet` — the
 *  user asked for something that did not happen. */
export function isSuccessOutcome(outcome: RegisterOutcome): boolean {
  return outcome !== 'unavailable' && outcome !== 'no-night' && outcome !== 'not-yet';
}

/**
 * Whether a failed proof or an unreachable proof server could explain this.
 *
 * The failure card carries a footnote pointing at Settings → Network, which is
 * good advice for a proving problem and actively misleading otherwise. Every
 * outcome here was decided BEFORE any proving happened — `not-yet` is refused by
 * the SDK before a transaction is built at all — so none of them can be a prover
 * fault, and the footnote is suppressed.
 */
export function mayBeProvingFailure(outcome: RegisterOutcome | null): boolean {
  return outcome === null || (outcome !== 'not-yet' && outcome !== 'no-night' && outcome !== 'unavailable');
}

/**
 * How a registration attempt ended, for the timings log.
 *
 * Registration can succeed at doing nothing: it RESOLVES with `txHash: null`
 * when there is no available unregistered NIGHT, or when the fee is not yet
 * affordable. Logging those as "complete" — which is what a plain
 * did-not-throw check does — made a wallet that submitted nothing look
 * identical to one that submitted twice, and sent a debugging session down the
 * wrong path entirely.
 *
 * No transaction hash: the timings page promises labels and durations only, and
 * a hash is chain-linkable to the wallet.
 */
export function registerTimingLabel(result: { txHash: string | null; notYet?: unknown }): string {
  if (result.txHash) return 'submitted';
  if (result.notYet) return 'no-op (fee not affordable yet)';
  return 'no-op (no available unregistered NIGHT)';
}
