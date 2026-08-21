// Client-side workaround for an off-by-one in
// @midnightntwrk/wallet-sdk-shielded and @midnightntwrk/wallet-sdk-dust-wallet.
//
// The SDKs' default applyUpdate looks roughly like:
//
//   const last = updates.at(-1);
//   if (BigInt(last.id) <= state.progress.appliedIndex) return early-skip;
//   replayEventsWithChanges(state, ..., updates.map(toEvent));
//   appliedIndex = BigInt(last.id);
//
// The early-skip only fires when the LAST event in the batch is already
// applied. When the indexer re-sends a boundary event (subscription
// reconnect, keepalive race, etc.) and that event sits at the head of an
// otherwise-fresh batch, the duplicate slips through to the WASM tree:
//
//   Error: values inserted non-linearly into zswap commitment tree;
//          expected to insert index N+1, but received N.
//
// The fix is to filter the batch BEFORE replay, dropping any event with
// id <= state.progress.appliedIndex. If everything filters out the
// behavior matches the SDK's own skip path; if some events remain we
// hand them to the original applyUpdate which advances appliedIndex
// against the new tail.
//
// We wrap rather than fork — V1Builder.withSync is the documented
// extension point.
//
// Sitting here also makes this the only place that sees the OTHER cause of the
// same ledger error: a restored snapshot whose recorded cursor is ahead of its
// own tree, so the first genuinely-new event is rejected. Nothing upstream can
// tell the two apart — one is a duplicate the tree already has, the other a
// legitimate event the tree is not ready for — and only here are both the
// batch's ids and the state's appliedIndex in hand. See classifyApplyFailure.

import {
  V1Builder as ShieldedV1Builder,
  Sync as ShieldedSync,
  CoreWallet as ShieldedCoreWallet,
} from '@midnightntwrk/wallet-sdk/shielded/v1';

import {
  V1Builder as DustV1Builder,
  SyncService as DustSyncService,
  CoreWallet as DustCoreWallet,
} from '@midnightntwrk/wallet-sdk/dust/v1';

type Updateish<T = unknown> = {
  readonly id: number | bigint | string;
  readonly maxId: number | bigint | string;
  readonly protocolVersion?: number | bigint;
} & T;

type WrappedUpdate<U> = {
  readonly updates: ReadonlyArray<U>;
  readonly [key: string]: unknown;
};

type ApplyUpdateFn<S, U> = (state: S, wrappedUpdate: WrappedUpdate<U>) => readonly [S, {changes: unknown[]; protocolVersion: number}];

interface Capability<S, U> {
  applyUpdate: ApplyUpdateFn<S, U>;
}

/**
 * The ledger refusing a commitment whose index is not its tree's next free slot.
 *
 * Matched on the message because that is all the WASM boundary offers — the
 * throw is a plain Error with nothing to switch on. Both trees word it the same
 * way ("values inserted non-linearly into <zswap|dust> commitment tree; expected
 * to insert index N, but received M"), so one pattern covers both sub-wallets.
 */
const NON_LINEAR_INSERT = /inserted non-linearly/i;

/**
 * A restored snapshot whose cursor is ahead of its own commitment tree.
 *
 * This is NOT the duplicate-event problem the rest of this file exists for. The
 * stream is contiguous and correct; the snapshot is short of where its own
 * `offset` claims it is, so the first genuinely-new event carries a commitment
 * index the tree cannot accept. The ledger is right to refuse it: inserting out
 * of order would leave a hole in the tree and silently invalidate every proof
 * built against the root from then on.
 *
 * Such a snapshot cannot be repaired in place. The ledger accepts exactly the
 * next index, so the resume point has to be exact — a rewind re-delivers events
 * the tree already has and fails the same way, and there is no local way to map
 * a tree position back to the event id that produced it. Discarding the state
 * and letting that sub-wallet sync from genesis is the only correct move, and is
 * what ADR 0003 means by failing closed to a genesis sync.
 *
 * Seen for real in the pre-seed reference shipped for preprod: its dust snapshot
 * records `offset` 1431375 (an event id) while its commitment tree holds
 * 1059933 entries — the state as of event 1431353. Resuming from that offset
 * skips 22 events, and every consumer of the reference dies here.
 */
export class InconsistentCachedStateError extends Error {
  /** Cursor the snapshot claimed, in dust/zswap event ids. */
  readonly appliedIndex: bigint;
  /** First event the stream had left to apply — always `appliedIndex + 1` here. */
  readonly firstFreshId: bigint;

  constructor(appliedIndex: bigint, firstFreshId: bigint, cause: unknown) {
    super(
      `cached sync state is behind its own cursor: it claims every event up to ${appliedIndex} is applied, ` +
        `but the ledger rejected the very next one (${firstFreshId}) — ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      {cause},
    );
    this.name = 'InconsistentCachedStateError';
    this.appliedIndex = appliedIndex;
    this.firstFreshId = firstFreshId;
  }
}

/**
 * Decide what a failed replay means, so the caller can act on it once.
 *
 * A non-linear insert has two possible authors, and they need opposite handling:
 *
 * - The batch we handed over starts exactly one past `appliedIndex`. The stream
 *   was contiguous, so nothing was missed in transit and the fault is the
 *   state's — surface it as InconsistentCachedStateError so the cache gets
 *   discarded rather than retried for ever.
 * - It starts later than that. Events went missing between the indexer and here,
 *   the cache is fine, and the original error is the honest one to raise: the
 *   SDK's retry re-subscribes from `appliedIndex - 1` and the gap heals itself.
 *   Evicting a good cache here would trade a self-healing hiccup for an hour of
 *   re-syncing.
 */
function classifyApplyFailure(
  err: unknown,
  appliedIndex: bigint,
  firstFreshId: bigint,
): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!NON_LINEAR_INSERT.test(message)) return err;
  if (firstFreshId !== appliedIndex + 1n) return err;
  return new InconsistentCachedStateError(appliedIndex, firstFreshId, err);
}

/**
 * Walk the updates array and split into "already applied" vs "still to
 * apply" against the wallet's current appliedIndex. The boundary event
 * — the one whose id equals appliedIndex — counts as already applied.
 */
function partitionByAppliedIndex<U extends Updateish>(
  updates: ReadonlyArray<U>,
  appliedIndex: bigint,
): {fresh: ReadonlyArray<U>; droppedCount: number} {
  const fresh: U[] = [];
  for (const u of updates) {
    if (BigInt(u.id) > appliedIndex) fresh.push(u);
  }
  return {fresh, droppedCount: updates.length - fresh.length};
}

function makeDedupingApplyUpdate<S extends {progress: {appliedIndex: bigint; [k: string]: unknown}; protocolVersion: number | bigint}, U extends Updateish>(
  base: Capability<S, U>,
  updateProgress: (state: S, patch: {highestRelevantWalletIndex: bigint; isConnected: boolean}) => S,
  /**
   * Told once, when the ledger proves the restored snapshot cannot be advanced.
   * The error is rethrown either way — the SDK owns the sync stream and will
   * retry it — so this exists purely to let the host react: drop the cache, and
   * stop waiting on a sync that can no longer finish.
   */
  onUnusableState?: (error: InconsistentCachedStateError) => void,
): ApplyUpdateFn<S, U> {
  // The SDK retries the whole sync stream on failure, so a broken snapshot
  // produces this error again every few seconds. Report the first one only;
  // the host's response (evict + give up) does not need repeating.
  let reported = false;
  const applyFresh = (state: S, batch: WrappedUpdate<U>, firstFreshId: bigint): readonly [S, {changes: unknown[]; protocolVersion: number}] => {
    try {
      return base.applyUpdate(state, batch);
    } catch (err) {
      const classified = classifyApplyFailure(err, state.progress.appliedIndex, firstFreshId);
      if (classified instanceof InconsistentCachedStateError && !reported) {
        reported = true;
        onUnusableState?.(classified);
      }
      throw classified;
    }
  };

  return (state, wrapped) => {
    if (wrapped.updates.length === 0) {
      return base.applyUpdate(state, wrapped);
    }

    const {fresh, droppedCount} = partitionByAppliedIndex(wrapped.updates, state.progress.appliedIndex);

    if (droppedCount === 0) {
      // No duplicates — fast path, defer entirely to the SDK.
      return applyFresh(state, wrapped, BigInt(wrapped.updates[0]!.id));
    }

    if (fresh.length === 0) {
      // Whole batch is already-applied. Mirror the SDK's own early-skip
      // shape so downstream observers see the same "still-connected,
      // bumped highest-relevant-index" signal.
      const tail = wrapped.updates[wrapped.updates.length - 1];
      const highestRelevantWalletIndex = BigInt(tail.maxId);
      return [
        updateProgress(state, {highestRelevantWalletIndex, isConnected: true}),
        {changes: [], protocolVersion: Number(state.protocolVersion)},
      ] as const;
    }

    // Partial overlap — hand only the fresh suffix to the SDK so its
    // own appliedIndex advancement still reflects the batch tail.
    return applyFresh(state, {...wrapped, updates: fresh}, BigInt(fresh[0]!.id));
  };
}

// The V1Builder generics evolve through each builder method (withSync
// narrows the configuration intersection, withTransacting adds more, etc).
// Annotating an exact return type is brittle and adds no value — callers
// pass the result directly to CustomShieldedWallet / CustomDustWallet,
// which already accept their own narrowed V1Builder type. Let TS infer.

/**
 * Build a V1Builder for the shielded wallet whose syncCapability filters
 * already-applied events before handing them to the SDK's
 * makeEventsSyncCapability. Pass to CustomShieldedWallet(cfg, builder).
 */
// The inferred narrow V1Builder type references internal SDK paths that
// aren't part of the SDK's public type surface, which makes the `.d.ts`
// non-portable. Callers always feed the result straight into
// CustomShieldedWallet(cfg, builder) / CustomDustWallet(cfg, builder),
// both of which accept their own builder generic — so the actual type
// at the call site is recovered. We return `unknown` here as a
// deliberate escape hatch, and the callers cast.

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function dedupingShieldedBuilder(onUnusableState?: (error: InconsistentCachedStateError) => void): unknown {
  return new ShieldedV1Builder().withDefaults().withSync(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ShieldedSync.makeEventsSyncService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_config: unknown, _getContext: unknown) => {
      const base = ShieldedSync.makeEventsSyncCapability();
      return {
        applyUpdate: makeDedupingApplyUpdate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          base as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state: any, patch: any) => ShieldedCoreWallet.updateProgress(state, patch),
          onUnusableState,
        ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

/**
 * Build a V1Builder for the dust wallet whose syncCapability filters
 * already-applied events before handing them to the SDK's
 * makeDefaultSyncCapability. Pass to CustomDustWallet(cfg, builder).
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function dedupingDustBuilder(onUnusableState?: (error: InconsistentCachedStateError) => void): unknown {
  return new DustV1Builder().withDefaults().withSync(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DustSyncService.makeDefaultSyncService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_config: unknown, _getContext: unknown) => {
      // makeDefaultSyncCapability ignores its args at runtime even though
      // V1Builder invokes the factory with (config, getContext).
      const base = (DustSyncService.makeDefaultSyncCapability as () => unknown)();
      return {
        applyUpdate: makeDedupingApplyUpdate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          base as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state: any, patch: any) => DustCoreWallet.updateProgress(state, patch),
          onUnusableState,
        ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

// Exported for unit-testing the boundary-filter logic in isolation,
// without needing a live SDK wallet instance.
export const __TEST_ONLY__ = {
  partitionByAppliedIndex,
  makeDedupingApplyUpdate,
};
