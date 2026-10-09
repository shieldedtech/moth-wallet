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
): ApplyUpdateFn<S, U> {
  return (state, wrapped, ...rest) => {
    // Version signals carry no event batch; only batches can hold a re-sent boundary event.
    if (!Array.isArray(wrapped.updates) || wrapped.updates.length === 0) {
      return base.applyUpdate(state, wrapped, ...rest);
    }

    const {fresh, droppedCount} = partitionByAppliedIndex(wrapped.updates, state.progress.appliedIndex);

    if (droppedCount === 0) {
      // No duplicates — fast path, defer entirely to the SDK.
      return base.applyUpdate(state, wrapped, ...rest);
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
    return base.applyUpdate(state, {...wrapped, updates: fresh}, ...rest);
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
};
