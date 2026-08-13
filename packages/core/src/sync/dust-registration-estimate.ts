// When a fresh wallet can actually register NIGHT for DUST generation.
//
// Registering is self-funding by design — it does not require the wallet to
// already hold DUST, which would be a bootstrap deadlock. Instead a
// DustRegistration carries `allow_fee_payment`, and the ledger lets the
// transaction pay its own fee out of the DUST its NIGHT *would have* generated
// had it been registered all along (midnight-ledger `spec/dust.md`, "because
// registrations run a challenge of paying for their own fees…").
//
// Self-funding is not the same as free. `generationless_fee_availability`
// (midnight-ledger `ledger/src/dust.rs`) caps that backdated amount at
//
//     elapsed_since_utxo_created * night_value * generation_decay_rate
//
// so it grows from zero. A wallet funded moments ago cannot cover the fee yet,
// and one holding very little NIGHT accrues towards it slowly: at the ledger's
// default parameters (5 DUST per NIGHT, ~1 week to cap) a 0.3 DUST registration
// fee needs roughly 36s at 1,000 NIGHT, 6 min at 100, an hour at 10, and 10
// hours at 1.
//
// Without a pre-flight the wallet builds the transaction, hands it to the SDK,
// and surfaces the SDK's own guard as a failure after the fact — which reads as
// a broken wallet rather than "not yet". Worse, our failure card blamed the
// proof server, which has nothing to do with it. This computes the answer up
// front so the wallet can say how long instead.
//
// Pure and WASM-free: the arithmetic is the part worth testing, and it needs no
// facade, no chain and no proving.

/** Per-UTxO generation figures, as the SDK's `estimateRegistration` reports
 *  them. All amounts in Specks. */
export interface DustGenerationSlice {
  /** Backdated DUST this UTxO could contribute right now. */
  generatedNow: bigint;
  /** Specks per second this UTxO accrues (`night_value * decay_rate`). */
  rate: bigint;
  /** Ceiling this UTxO can ever reach (`night_value * night_dust_ratio`). */
  maxCap: bigint;
  /** Already backing DUST, so excluded from backdated fee payment — the
   *  ledger's `!night_indices.contains_key(initial_nonce)` filter. */
  registeredForDustGeneration: boolean;
}

export interface DustRegistrationEstimate {
  /** What the registration costs, in Specks. */
  fee: bigint;
  /** Backdated DUST available to it right now. */
  available: bigint;
  /** Combined accrual, in Specks per second. */
  rate: bigint;
  /** The most this NIGHT could ever offer, however long the wallet waits. */
  maxAvailable: bigint;
  /** Whether registering would succeed now. */
  affordable: boolean;
  /**
   * Seconds until `available` reaches `fee`.
   *
   * `0` when already affordable. `null` when waiting cannot get there — either
   * nothing is accruing, or the ceiling is below the fee, in which case the
   * answer is "hold more NIGHT", not "wait longer". Distinguishing these
   * matters: telling someone to wait for something that will never arrive is
   * worse than telling them nothing.
   */
  secondsUntilAffordable: number | null;
}

/** Specks in one DUST — the ledger's SPECKS_PER_DUST. */
const SPECKS_PER_DUST = 1_000_000_000_000_000n;

/** Whole DUST to 4dp, for messages a person reads. */
function formatDust(specks: bigint): string {
  const whole = specks / SPECKS_PER_DUST;
  const frac = ((specks % SPECKS_PER_DUST) * 10_000n) / SPECKS_PER_DUST;
  return `${whole}.${frac.toString().padStart(4, '0')}`;
}

/** A rough, readable duration. Deliberately vague at the top end: the estimate
 *  assumes the holding does not change, and "about 8 hours" carries that
 *  honestly where "7h 55m 12s" would imply a precision it does not have. */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 3_600) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) {
    const hours = Math.round((seconds / 3_600) * 10) / 10;
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round((seconds / 86_400) * 10) / 10;
  return `about ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Registration cannot pay its own fee yet.
 *
 * A distinct type because this is not a failure in any useful sense — nothing
 * was built, nothing booked, nothing spent, and the same call will succeed later
 * with no change to the wallet. Callers that show it as an error alongside
 * genuine ones (a dead node, a refused proof) mislead: this one just needs time,
 * or more NIGHT.
 */
export class DustRegistrationNotYetError extends Error {
  readonly estimate: DustRegistrationEstimate;

  constructor(estimate: DustRegistrationEstimate, cause?: unknown) {
    const have = formatDust(estimate.available);
    const need = formatDust(estimate.fee);
    super(
      estimate.secondsUntilAffordable === null
        ? `Registration costs ${need} DUST of backdated generation, but this NIGHT can only ever provide ` +
            `${formatDust(estimate.maxAvailable)} DUST. Hold more NIGHT and try again.`
        : `Registration pays its own fee from the DUST this NIGHT would already have generated. ` +
            `It needs ${need} DUST and has ${have} so far — ${describeWait(estimate.secondsUntilAffordable)} to go. ` +
            `Nothing was spent.`,
      {cause},
    );
    this.name = 'DustRegistrationNotYetError';
    this.estimate = estimate;
  }
}

export function estimateRegistrationAffordability(
  fee: bigint,
  slices: readonly DustGenerationSlice[],
): DustRegistrationEstimate {
  // Only UTxOs not already backing DUST can fund a registration by backdating.
  const eligible = slices.filter((s) => !s.registeredForDustGeneration);
  const sum = (pick: (s: DustGenerationSlice) => bigint): bigint =>
    eligible.reduce((total, s) => total + pick(s), 0n);

  const available = sum((s) => s.generatedNow);
  const rate = sum((s) => s.rate);
  const maxAvailable = sum((s) => s.maxCap);

  if (available >= fee) {
    return {fee, available, rate, maxAvailable, affordable: true, secondsUntilAffordable: 0};
  }

  // Unreachable rather than slow. Both cases are real: a wallet whose NIGHT is
  // all registered already has no accrual to wait on, and a wallet holding too
  // little NIGHT tops out below the fee.
  const reachable = rate > 0n && maxAvailable >= fee;
  const shortfall = fee - available;

  return {
    fee,
    available,
    rate,
    maxAvailable,
    affordable: false,
    // Ceiling, not rounding: at the exact quotient the balance has only just
    // reached the fee, and reporting a second early sends the user back to the
    // same failure.
    secondsUntilAffordable: reachable ? Number((shortfall + rate - 1n) / rate) : null,
  };
}
