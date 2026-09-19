// Detecting a wedged devnet dust ledger — see docs/bugs-found.md-style report
// filed upstream: a devnet's dust state can enter a state where NO wallet can
// spend DUST any more, and every rejection carries the exact same client
// signature ("1010: Invalid Transaction: Custom error: 170" /
// `Malformed(InvalidDustSpendProof)`) as two entirely different, recoverable
// conditions:
//
//   1. A transient race (~1 in 3 attempts, immediately after the same wallet
//      spent): the wallet's declared dust-state timestamp disagreed with the
//      node's. Retrying a FRESH build+submit (never a byte-for-byte resend —
//      that proves nothing new) succeeds.
//   2. The wedge itself: something about a DUST registration (size and delay
//      both ruled out individually) leaves the node's dust state unable to
//      reconcile with ANY wallet's, permanently. Blocks keep being produced;
//      nothing but a chain reset clears it.
//
// A single rejection proves nothing — (1) alone produces the identical string.
// This module exists to tell (2) apart from (1) without guessing: require the
// SAME signature to repeat across several INDEPENDENT submissions while the
// chain keeps producing new blocks. Only then is a wedge, rather than bad luck,
// the better explanation. (A third cause, a wallet/node ledger-version
// mismatch, exists only once more than one ledger generation is in play; this
// build speaks one ledger, so there is nothing to rule out here.)
//
// Deliberately does not change how a transaction is built, signed or proven —
// this only classifies what a rejection means, after the ledger/SDK has
// already accepted or refused it.

import {WalletError} from '../types/errors.js';

/** Consecutive independently-built submissions carrying the same ambiguous
 *  signature before Moth calls the network wedged rather than unlucky.
 *  Chosen above the ~1-in-3 rate of the known transient (docs bugs #6): three
 *  in a row is already an unlikely coincidence if each attempt were an
 *  independent 1/3 chance, and every documented wedge is "the first spend
 *  after registration, and every one since" — a wedge fails at 100%, not 33%.
 */
export const DEFAULT_WEDGE_THRESHOLD = 3;

/** Matches the client-visible shape of an InvalidDustSpendProof rejection,
 *  under whichever wrapping the SDK / RPC layer puts around the node's raw
 *  `1010: Invalid Transaction: Custom error: 170` or the node-log spelling
 *  `Malformed(InvalidDustSpendProof)` (surfaced to a client that reads node
 *  logs directly, e.g. a devnet operator's tooling). */
export function isDustSpendProofRejection(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /custom error:\s*170\b|invaliddustspendproof/i.test(msg);
}

/**
 * The network's dust ledger can no longer verify anyone's spends. Distinct
 * from a normal submission failure: retrying does not help, importing a
 * different wallet does not help, and the only known fix is resetting the
 * chain (a fresh chain has never reproduced this on its first transaction).
 */
export class DustLedgerWedgedError extends WalletError {
  readonly networkId: string;
  readonly consecutiveRejections: number;

  constructor(networkId: string, consecutiveRejections: number, cause?: unknown) {
    super(
      'NETWORK_ERROR',
      `${networkId}'s dust ledger can no longer verify anyone's spends (known devnet defect). ` +
        `${consecutiveRejections} independent submissions in a row were rejected with the same ` +
        `"invalid dust spend proof" signature while the chain kept producing new blocks — that ` +
        `rules out a one-off race. This is not something retrying or switching ` +
        `wallets fixes: the network needs a reset. If you operate ${networkId}, reset the chain; ` +
        `otherwise wait for its operator to, or switch to a different network.`,
      cause,
    );
    this.name = 'DustLedgerWedgedError';
    this.networkId = networkId;
    this.consecutiveRejections = consecutiveRejections;
  }
}

/**
 * One wallet's run of consecutive InvalidDustSpendProof outcomes on one
 * network, across independently built-and-submitted transactions.
 *
 * A hit anywhere else — a success, or a failure with a different signature —
 * resets the streak: only a run of the identical ambiguous signature, back to
 * back, with nothing else happening in between, is evidence of anything.
 */
export class DustSpendHealthTracker {
  private streak = 0;
  private heightAtFirstRejection: number | undefined;

  get consecutiveRejections(): number {
    return this.streak;
  }

  /** A dust spend went through. Whatever was happening before, it isn't now. */
  recordSuccess(): void {
    this.streak = 0;
    this.heightAtFirstRejection = undefined;
  }

  /** A submission failed for some other reason (or this one couldn't be
   *  classified — e.g. the indexer was unreachable). Breaks the streak: a
   *  wedge is a run of the SAME signature, not failures in general. */
  recordUnrelatedFailure(): void {
    this.streak = 0;
    this.heightAtFirstRejection = undefined;
  }

  /** Record one InvalidDustSpendProof rejection observed at chain height
   *  `tipHeight`. Returns the streak length after recording. */
  recordProofRejection(tipHeight: number): number {
    if (this.streak === 0) this.heightAtFirstRejection = tipHeight;
    this.streak += 1;
    return this.streak;
  }

  /** Whether the chain has produced at least one new block since this streak
   *  began. Separates a wedged dust ledger (blocks keep coming; nothing
   *  reconciles) from a stalled node or indexer, where every read — including
   *  this one — would already be failing the same way and there would be
   *  nothing distinctive to detect. */
  blocksAdvancedSince(tipHeight: number): boolean {
    return this.heightAtFirstRejection !== undefined && tipHeight > this.heightAtFirstRejection;
  }
}

const trackers = new Map<string, DustSpendHealthTracker>();

/** One tracker per (network, wallet), shared by every submission path so a
 *  registration's rejection and a transfer's rejection on the same wallet
 *  count toward the same streak. */
export function dustSpendHealthTracker(networkId: string, walletName: string): DustSpendHealthTracker {
  const key = `${networkId}/${walletName}`;
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = new DustSpendHealthTracker();
    trackers.set(key, tracker);
  }
  return tracker;
}

/** Test-only: drop every tracker between cases. */
export function resetDustSpendHealthTrackers(): void {
  trackers.clear();
}

export interface DustLedgerHealthContext {
  readonly network: {readonly id: string; readonly indexerUrl: string};
  /** Consecutive rejections required before declaring a wedge. */
  readonly threshold?: number;
  /** Injectable for tests; defaults to one indexer read. */
  readonly probeBlock?: (indexerUrl: string) => Promise<{height: number} | undefined>;
}

/**
 * Classify one submission failure and return the error Moth should surface:
 * the original error, or {@link DustLedgerWedgedError} (not recoverable from
 * the client). Never throws itself; the caller throws whatever comes back, e.g.:
 *
 * ```ts
 * try {
 *   const hash = await submitFinalizedTransaction(facade, finalized);
 *   tracker.recordSuccess();
 *   return hash;
 * } catch (err) {
 *   throw await diagnoseSubmissionFailure(tracker, err, { network });
 * }
 * ```
 *
 * Costs one indexer round trip, and only when the rejection actually matches
 * the ambiguous signature — every other failure returns immediately.
 */
export async function diagnoseSubmissionFailure(
  tracker: DustSpendHealthTracker,
  error: unknown,
  context: DustLedgerHealthContext,
): Promise<Error> {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!isDustSpendProofRejection(error)) {
    tracker.recordUnrelatedFailure();
    return original;
  }

  const probe = context.probeBlock ?? defaultProbeBlock;
  const block = await probe(context.network.indexerUrl).catch(() => undefined);
  if (!block) {
    // Can't confirm the chain is even producing blocks, so nothing here is
    // conclusive — but it also isn't evidence of a wedge, since a wedge is
    // defined by everything else working while dust alone fails.
    tracker.recordUnrelatedFailure();
    return original;
  }

  const streak = tracker.recordProofRejection(block.height);
  const threshold = context.threshold ?? DEFAULT_WEDGE_THRESHOLD;
  if (streak < threshold) return original; // condition (1): too early to tell from a transient race

  if (!tracker.blocksAdvancedSince(block.height)) return original; // chain itself may be stalled — a different, undiagnosed problem

  return new DustLedgerWedgedError(context.network.id, streak, original);
}

export interface SubmitHealthContext {
  readonly network: {readonly id: string; readonly indexerUrl: string};
  readonly walletName: string;
  readonly threshold?: number;
  readonly probeBlock?: DustLedgerHealthContext['probeBlock'];
}

/**
 * Wrap one fee-paying submission with wedge detection: run `submit`, clear the
 * wallet's rejection streak on success, and on failure reclassify the error
 * through {@link diagnoseSubmissionFailure} before rethrowing. Shared by every
 * surface that submits transactions directly — the extension's offscreen host,
 * the CLI's transfer/dust commands, and the daemon — so a registration's
 * rejection and a transfer's rejection on the same wallet count toward the
 * same streak regardless of which surface made them.
 */
export async function submitWithHealthTracking<T>(
  submit: () => Promise<T>,
  context: SubmitHealthContext,
): Promise<T> {
  const tracker = dustSpendHealthTracker(context.network.id, context.walletName);
  try {
    const result = await submit();
    tracker.recordSuccess();
    return result;
  } catch (e) {
    throw await diagnoseSubmissionFailure(tracker, e, {
      network: context.network,
      threshold: context.threshold,
      probeBlock: context.probeBlock,
    });
  }
}

async function defaultProbeBlock(indexerUrl: string): Promise<{height: number} | undefined> {
  const {IndexerClient} = await import('../network/indexer-client.js');
  const block = await new IndexerClient(indexerUrl).getBlock();
  return block ? {height: block.height} : undefined;
}
