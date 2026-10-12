import {sdk} from '../sdk/index.js';
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
// We wrap rather than fork — the variant builder's withSync is the documented
// extension point.



type Updateish<T = unknown> = {
  readonly id: number | bigint | string;
  readonly maxId: number | bigint | string;
  readonly protocolVersion?: number | bigint;
} & T;

type WrappedUpdate<U> = {
  readonly updates: ReadonlyArray<U>;
  readonly [key: string]: unknown;
};

// `rest` carries what newer SDKs pass after the update (ledger-v9 variants: the active protocol range).
type ApplyUpdateFn<S, U> = (
  state: S,
  wrappedUpdate: WrappedUpdate<U>,
  ...rest: unknown[]
) => readonly [S, {changes: unknown[]; protocolVersion: number}];

interface Capability<S, U> {
  applyUpdate: ApplyUpdateFn<S, U>;
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
  rest: unknown[] = [],
): readonly [S, {changes: unknown[]; protocolVersion: number}] {
  try {
    return base.applyUpdate(state, updates === wrapped.updates ? wrapped : {...wrapped, updates}, ...rest);
  } catch (err) {
    throw enrichNonLinear(err, {appliedIndex: state.progress.appliedIndex, updates, droppedCount});
  }
}

function makeDedupingApplyUpdate<S extends {progress: {appliedIndex: bigint; [k: string]: unknown}; protocolVersion: number | bigint}, U extends Updateish>(
  base: Capability<S, U>,
  updateProgress: (state: S, patch: {highestRelevantWalletIndex: bigint; isConnected: boolean}) => S,
): ApplyUpdateFn<S, U> {
  return (state, wrapped, ...rest) => {
    // Version signals carry no event batch; only batches can hold a re-sent boundary event.
    if (!Array.isArray(wrapped.updates) || wrapped.updates.length === 0) {
      return base.applyUpdate(state, wrapped, ...rest);
    }

    const {fresh, droppedCount, outOfOrder} = partitionByAppliedIndex(
      wrapped.updates,
      state.progress.appliedIndex,
    );

    if (outOfOrder) {
      // Not the ascending stream this filter assumes. Dropping a mid-batch event
      // here is what creates the hole the tree rejects, so drop nothing and let
      // the SDK decide — its own skip path is the conservative one.
      return applyGuarded(base, state, wrapped, wrapped.updates, 0, rest);
    }

    if (droppedCount === 0) {
      // No duplicates — fast path, defer entirely to the SDK.
      return applyGuarded(base, state, wrapped, wrapped.updates, 0, rest);
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
    return applyGuarded(base, state, wrapped, fresh, droppedCount, rest);
  };
}

// The variant builder generics evolve through each builder method (withSync
// narrows the configuration intersection, withTransacting adds more, etc).
// Annotating an exact return type is brittle and adds no value — callers
// pass the result directly to CustomShieldedWallet / CustomDustWallet,
// which already accept their own narrowed builder type. Let TS infer.

/**
 * Build a variant builder for the shielded wallet whose syncCapability filters
 * already-applied events before handing them to the SDK's
 * makeEventsSyncCapability. Pass to CustomShieldedWallet(cfg, builder).
 */
// The inferred narrow builder type references internal SDK paths that
// aren't part of the SDK's public type surface, which makes the `.d.ts`
// non-portable. Callers always feed the result straight into
// CustomShieldedWallet(cfg, builder) / CustomDustWallet(cfg, builder),
// both of which accept their own builder generic — so the actual type
// at the call site is recovered. We return `unknown` here as a
// deliberate escape hatch, and the callers cast.

// The v8 SDK's variants build with V1Builder, the v9 SDK's ledger-v9 variants with V2Builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function variantBuilder(variant: any): new () => any {
  return 'V2Builder' in variant ? variant.V2Builder : variant.V1Builder;
}

// Replacing sync clears the key derivation on v9 builders; the dedup wraps the default sync, so the default holds.
// The v8 SDK's builders have no such step.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDefaultStartAux(builder: any): unknown {
  return typeof builder.withStartAuxDefaults === 'function' ? builder.withStartAuxDefaults() : builder;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function dedupingShieldedBuilder(): unknown {
  return withDefaultStartAux(new (variantBuilder(sdk().shieldedVariant))().withDefaults().withSync(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk().shieldedVariant.Sync.makeEventsSyncService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_config: unknown, _getContext: unknown) => {
      const base = sdk().shieldedVariant.Sync.makeEventsSyncCapability();
      return {
        applyUpdate: makeDedupingApplyUpdate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          base as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state: any, patch: any) => sdk().shieldedVariant.CoreWallet.updateProgress(state, patch),
        ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  ));
}

/**
 * Build a variant builder for the dust wallet whose syncCapability filters
 * already-applied events before handing them to the SDK's
 * makeDefaultSyncCapability. Pass to CustomDustWallet(cfg, builder).
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function dedupingDustBuilder(): unknown {
  return withDefaultStartAux(new (variantBuilder(sdk().dustVariant))().withDefaults().withSync(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk().dustVariant.SyncService.makeDefaultSyncService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((_config: unknown, _getContext: unknown) => {
      // makeDefaultSyncCapability ignores its args at runtime even though
      // The builder invokes the factory with (config, getContext).
      const base = (sdk().dustVariant.SyncService.makeDefaultSyncCapability as () => unknown)();
      return {
        applyUpdate: makeDedupingApplyUpdate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          base as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state: any, patch: any) => sdk().dustVariant.CoreWallet.updateProgress(state, patch),
        ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  ));
}

// Exported for unit-testing the boundary-filter logic in isolation,
// without needing a live SDK wallet instance.
export const __TEST_ONLY__ = {
  partitionByAppliedIndex,
  makeDedupingApplyUpdate,
  enrichNonLinear,
};
