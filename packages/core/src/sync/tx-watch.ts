// Watching a submitted transaction until the chain shows it — and unwinding the
// wallet's optimistic bookkeeping when it never does.
//
// Moth resolves a submission at 'Submitted' (the node's pool accepted it), not
// 'Finalized', so a send returns in seconds rather than blocking on a block. The
// SDK's dust wallet books the fee at build time: `DustLocalState.spend()` marks
// the input coin pending for the ledger's grace period (3 h), during which the
// coin is hidden from `utxos`, the balance and fee selection. Only the
// `DustSpendProcessed` event for that spend replaces it with its successor.
//
// A transaction the pool accepted and then dropped — a dust proof against a
// rotated root, an intent past its TTL, a node restart — produces no event. The
// coin then stays hidden for the full three hours while the wallet reports
// `dustSynced: true`, and every fee that needed it fails with "could not balance
// dust". Preprod, 2026-09-22 13:55Z: a 990-NIGHT coin (≈500 DUST) vanished this
// way after a spend that never landed; the sibling 10-NIGHT coin carried the
// next sixteen fees until it ran dry.
//
// The watcher polls the indexer for the transaction hash. If it is not included
// within the window, `revert` runs the facade's `revertTransaction`, which the
// dust wallet maps to `processTtls(spendTime + grace)`: the ledger un-pends the
// input, and the coin is spendable again. Reverting early is safe: should the
// transaction land after all, the event still finds the coin by nullifier and
// applies the spend as usual.

export type InclusionOutcome =
  | {kind: 'included'; afterMs: number}
  | {kind: 'reverted'; afterMs: number}
  /** The window passed and the revert itself failed; the coin stays hidden until the grace period. */
  | {kind: 'revert-failed'; afterMs: number; error: string}
  | {kind: 'cancelled'; afterMs: number};

export interface WatchInclusionOptions {
  readonly hash: string;
  /** True once the chain (as the indexer sees it) includes the transaction. Errors count as "not yet". */
  readonly isIncluded: (hash: string) => Promise<boolean>;
  /** Undo the wallet's optimistic bookkeeping for the transaction. */
  readonly revert: () => Promise<void>;
  /** How long a pool-accepted transaction may go unseen before it is presumed dropped. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly onOutcome?: (outcome: InclusionOutcome) => void;
  /** Clock and timer injection for tests. */
  readonly now?: () => number;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

export interface InclusionWatch {
  readonly done: Promise<InclusionOutcome>;
  cancel(): void;
}

/**
 * Preprod includes a pool-accepted transaction in the next block or two (≈6–30 s).
 * Ten minutes is far past anything that will still land, and well inside the
 * three hours the ledger would otherwise keep the fee coin hidden.
 */
export const DEFAULT_INCLUSION_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_INCLUSION_POLL_MS = 20_000;

export function watchInclusion(opts: WatchInclusionOptions): InclusionWatch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INCLUSION_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_INCLUSION_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.setTimeoutFn ?? setTimeout;
  const unschedule = opts.clearTimeoutFn ?? clearTimeout;
  const started = now();

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (o: InclusionOutcome) => void;
  const done = new Promise<InclusionOutcome>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (outcome: InclusionOutcome) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) unschedule(timer);
    try {
      opts.onOutcome?.(outcome);
    } catch {
      /* observer error must not affect the wallet */
    }
    resolveDone(outcome);
  };

  const tick = async () => {
    if (settled) return;
    let included = false;
    try {
      included = await opts.isIncluded(opts.hash);
    } catch {
      included = false;
    }
    if (settled) return;
    const elapsed = now() - started;
    if (included) {
      finish({kind: 'included', afterMs: elapsed});
      return;
    }
    if (elapsed >= timeoutMs) {
      try {
        await opts.revert();
        finish({kind: 'reverted', afterMs: elapsed});
      } catch (err) {
        finish({kind: 'revert-failed', afterMs: elapsed, error: err instanceof Error ? err.message : String(err)});
      }
      return;
    }
    timer = schedule(() => void tick(), Math.min(pollMs, timeoutMs - elapsed));
  };

  timer = schedule(() => void tick(), pollMs);

  return {
    done,
    cancel: () => finish({kind: 'cancelled', afterMs: now() - started}),
  };
}
