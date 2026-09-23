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

export type SyncPart = 'shielded' | 'dust';

/** The ledger tree rejected a replay. Retrying replays the same batch from the same cursor, so this cache is done. */
export interface SyncInconsistency {
  readonly part: SyncPart;
  readonly appliedIndex: bigint;
  /** Ids of the batch that was rejected. */
  readonly range: string;
  readonly message: string;
}

/**
 * A batch whose first fresh id is more than one past the cursor.
 *
 * Diagnostic only. Indexer event ids are one global serial shared by the zswap,
 * dust and contract streams, so a dust batch routinely skips the ids other
 * streams used up — twelve gaps in four hundred ids on preprod. What a gap
 * cannot prove is a lost event; that verdict belongs to the tree, which rejects
 * the insert (see SyncInconsistency). It is reported so a run of gaps around a
 * later failure can be read back.
 */
export interface SyncGap {
  readonly part: SyncPart;
  readonly appliedIndex: bigint;
  readonly firstFreshId: bigint;
  readonly batchSize: number;
}

export interface DedupHooks {
  onInconsistent?: (info: SyncInconsistency) => void;
  onGap?: (info: SyncGap) => void;
}

/**
 * Walk the updates array and split into "already applied" vs "still to
 * apply" against the wallet's current appliedIndex. The boundary event
 * — the one whose id equals appliedIndex — counts as already applied.
 */
function partitionByAppliedIndex<U extends Updateish>(
  updates: ReadonlyArray<U>,
  appliedIndex: bigint,
): {fresh: ReadonlyArray<U>; droppedCount: number; outOfOrder: boolean} {
  // Prefix only. The previous form filtered the whole array by predicate, which
  // for an out-of-order batch removes an already-applied event from the MIDDLE
  // and hands the SDK a replay with a hole in it — the ledger tree then rejects
  // the insert as non-linear, four layers down, naming none of this.
  let i = 0;
  while (i < updates.length && BigInt(updates[i]!.id) <= appliedIndex) i++;
  const fresh = updates.slice(i);
  // An already-applied id after the first fresh one means this batch is not the
  // ascending stream the filter assumes, so its result cannot be trusted.
  const outOfOrder = fresh.some((u) => BigInt(u.id) <= appliedIndex);
  return {fresh, droppedCount: i, outOfOrder};
}

const NON_LINEAR = /inserted non-linearly/i;

/**
 * Turn the ledger's bare non-linear-insert message into something that names
 * the cause and the way out.
 *
 * The tree rejects the insert because the events it needed never reached it.
 * Retrying cannot help — the same batch replays from the same cursor — so a
 * wallet in this state loops on one error forever. The cursor and batch shape
 * are the evidence for which side dropped them, so they go in the message.
 */
function enrichNonLinear<U extends Updateish>(
  err: unknown,
  ctx: {appliedIndex: bigint; updates: ReadonlyArray<U>; droppedCount: number},
): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!NON_LINEAR.test(message)) return err;
  const ids = ctx.updates.map((u) => BigInt(u.id));
  const range = ids.length === 0 ? '(empty batch)' : `${ids[0]}..${ids[ids.length - 1]}`;
  const enriched = new Error(
    `${message}\n` +
      `The sync cache is inconsistent with the event stream and will not recover on ` +
      `retry — the same batch replays from the same cursor. ` +
      `appliedIndex=${ctx.appliedIndex}, replayed ${ids.length} event(s) ${range}, ` +
      `${ctx.droppedCount} dropped as already applied. ` +
      `Clear this wallet part's sync cache and resync to recover.`,
  );
  (enriched as Error & {cause?: unknown}).cause = err;
  return enriched;
}

/** Call the SDK, enriching a non-linear-insert failure with the cursor context. */
function applyGuarded<S, U extends Updateish>(
  base: Capability<S, U>,
  state: S & {progress: {appliedIndex: bigint}},
  wrapped: WrappedUpdate<U>,
  updates: ReadonlyArray<U>,
  droppedCount: number,
  hooks?: DedupHooks,
  part: SyncPart = 'dust',
): readonly [S, {changes: unknown[]; protocolVersion: number}] {
  try {
    return base.applyUpdate(state, updates === wrapped.updates ? wrapped : {...wrapped, updates});
  } catch (err) {
    const enriched = enrichNonLinear(err, {appliedIndex: state.progress.appliedIndex, updates, droppedCount});
    if (enriched !== err && hooks?.onInconsistent) {
      // The host decides what to do with a dead cache — mark the part unsynced,
      // evict it, resync. Left to the retry loop alone, a wallet in this state
      // logged the same error 9,300 times over five hours (preprod, 2026-09-20).
      const ids = updates.map((u) => BigInt(u.id));
      const range = ids.length === 0 ? '(empty batch)' : `${ids[0]}..${ids[ids.length - 1]}`;
      try {
        hooks.onInconsistent({
          part,
          appliedIndex: state.progress.appliedIndex,
          range,
          message: enriched instanceof Error ? enriched.message : String(enriched),
        });
      } catch {
        /* a failing observer must not mask the sync error */
      }
    }
    throw enriched;
  }
}

function makeDedupingApplyUpdate<S extends {progress: {appliedIndex: bigint; [k: string]: unknown}; protocolVersion: number | bigint}, U extends Updateish>(
  base: Capability<S, U>,
  updateProgress: (state: S, patch: {highestRelevantWalletIndex: bigint; isConnected: boolean}) => S,
  hooks?: DedupHooks,
  part: SyncPart = 'dust',
): ApplyUpdateFn<S, U> {
  return (state, wrapped) => {
    if (wrapped.updates.length === 0) {
      return base.applyUpdate(state, wrapped);
    }

    const {fresh, droppedCount, outOfOrder} = partitionByAppliedIndex(
      wrapped.updates,
      state.progress.appliedIndex,
    );

    if (hooks?.onGap && !outOfOrder && fresh.length > 0 && state.progress.appliedIndex > 0n) {
      const firstFreshId = BigInt(fresh[0]!.id);
      if (firstFreshId > state.progress.appliedIndex + 1n) {
        try {
          hooks.onGap({part, appliedIndex: state.progress.appliedIndex, firstFreshId, batchSize: fresh.length});
        } catch {
          /* diagnostic only */
        }
      }
    }

    if (outOfOrder) {
      // Not the ascending stream this filter assumes. Dropping a mid-batch event
      // here is what creates the hole the tree rejects, so drop nothing and let
      // the SDK decide — its own skip path is the conservative one.
      return applyGuarded(base, state, wrapped, wrapped.updates, 0, hooks, part);
    }

    if (droppedCount === 0) {
      // No duplicates — fast path, defer entirely to the SDK.
      return applyGuarded(base, state, wrapped, wrapped.updates, 0, hooks, part);
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
    return applyGuarded(base, state, wrapped, fresh, droppedCount, hooks, part);
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
export function dedupingShieldedBuilder(hooks?: DedupHooks): unknown {
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
          hooks,
          'shielded',
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
export function dedupingDustBuilder(hooks?: DedupHooks): unknown {
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
          hooks,
          'dust',
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
  enrichNonLinear,
};
