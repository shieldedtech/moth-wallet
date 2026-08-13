# Wallet SDK sync `applyUpdate` lets re-sent boundary events trip the WASM tree

Target: `@midnight-ntwrk/wallet-sdk-shielded` and `@midnight-ntwrk/wallet-sdk-dust-wallet`.

Tested against `wallet-sdk@1.1.0`, `ledger-v8@8.1.0`.

## Symptom

During a sync against a live indexer, the WASM ledger throws:

```
Error: values inserted non-linearly into zswap commitment tree;
       expected to insert index N+1, but received N.
```

(or `dust commitment tree` for the dust variant).

Reproduced repeatably on preprod with a freshly-cleared sync cache. Index N is the
boundary event the wallet has just finished applying.

## Root cause

In both packages, `applyUpdate` short-circuits an already-applied batch only when
the **last** event in the batch is `<= state.progress.appliedIndex`. The full
`updates` array is then handed to `replayEventsWithChanges`, including any
duplicate at the head.

Shielded — `wallet-sdk-shielded/dist/v1/Sync.js` (line numbers from v1.1.0):

```js
applyUpdate: (state, wrappedUpdate) => {
  if (wrappedUpdate.updates.length === 0) {
    return [state, { changes: [], protocolVersion: Number(state.protocolVersion) }];
  }
  const lastUpdate = wrappedUpdate.updates.at(-1);
  const nextIndex = BigInt(lastUpdate.id);
  const highestRelevantWalletIndex = BigInt(lastUpdate.maxId);
  // in case the nextIndex is less than or equal to the appliedIndex
  // just update highestRelevantWalletIndex
  if (nextIndex <= state.progress.appliedIndex) {
    return [
      CoreWallet.updateProgress(state, { highestRelevantWalletIndex, isConnected: true }),
      { changes: [], protocolVersion: lastUpdate.protocolVersion },
    ];
  }
  const [newState, newChanges] = CoreWallet.replayEventsWithChanges(
    state, wrappedUpdate.secretKeys, wrappedUpdate.updates.map((u) => u.event));
  const updatedState = CoreWallet.updateProgress(newState, {
    highestRelevantWalletIndex, appliedIndex: nextIndex, isConnected: true,
  });
  return [updatedState, { changes: newChanges, protocolVersion: lastUpdate.protocolVersion }];
}
```

Dust — `wallet-sdk-dust-wallet/dist/v1/Sync.js` follows the same shape with
identical bug.

## When this fires

The boundary event with `id == appliedIndex` appears at the head of an otherwise
fresh batch. The condition `nextIndex <= appliedIndex` is false (the batch tail
is past the wallet), so the duplicate is included in
`updates.map(u => u.event)` and `replayEventsWithChanges` rejects it.

Triggers in practice:

- WebSocket subscription reconnects (server-side timeout, network blip, indexer
  pod restart) and the new subscription re-emits the boundary event.
- Two concurrent processes syncing the same wallet — increased subscription
  churn makes the race much more likely.

With `batchUpdates.size = 10` (SDK default) the surface is small and the bug
rarely fires. With `batchUpdates.size = 1000` (a common override for resync
performance) the surface widens enough that the bug fires reliably on any
non-trivial historical scan.

## Fix

Filter the batch before passing to `replayEventsWithChanges`. The current
short-circuit can stay as a fast-path, but `applyUpdate` must also handle the
mixed case where some events in the batch are at or below `appliedIndex` and
some are above it.

Suggested diff for the shielded SDK (the dust SDK takes the same change with
`updates.map(u => u.raw)` instead of `u.event`):

```diff
 applyUpdate: (state, wrappedUpdate) => {
-  if (wrappedUpdate.updates.length === 0) {
+  const fresh = wrappedUpdate.updates.filter(
+    (u) => BigInt(u.id) > state.progress.appliedIndex,
+  );
+  if (fresh.length === 0) {
+    const last = wrappedUpdate.updates.at(-1);
+    if (!last) {
+      return [state, { changes: [], protocolVersion: Number(state.protocolVersion) }];
+    }
     return [
-      state,
-      { changes: [], protocolVersion: Number(state.protocolVersion) },
+      CoreWallet.updateProgress(state, {
+        highestRelevantWalletIndex: BigInt(last.maxId),
+        isConnected: true,
+      }),
+      { changes: [], protocolVersion: Number(last.protocolVersion) },
     ];
   }
-  const lastUpdate = wrappedUpdate.updates.at(-1);
+  const lastUpdate = fresh.at(-1);
   const nextIndex = BigInt(lastUpdate.id);
   const highestRelevantWalletIndex = BigInt(lastUpdate.maxId);
-  if (nextIndex <= state.progress.appliedIndex) {
-    return [
-      CoreWallet.updateProgress(state, { highestRelevantWalletIndex, isConnected: true }),
-      { changes: [], protocolVersion: lastUpdate.protocolVersion },
-    ];
-  }
   const [newState, newChanges] = CoreWallet.replayEventsWithChanges(
-    state, wrappedUpdate.secretKeys, wrappedUpdate.updates.map((u) => u.event));
+    state, wrappedUpdate.secretKeys, fresh.map((u) => u.event));
   const updatedState = CoreWallet.updateProgress(newState, {
     highestRelevantWalletIndex, appliedIndex: nextIndex, isConnected: true,
   });
   return [updatedState, { changes: newChanges, protocolVersion: lastUpdate.protocolVersion }];
 }
```

`fresh.length === wrappedUpdate.updates.length` is the existing fast path; no
behavior change. `fresh.length === 0` collapses the SDK's current
empty-batch + last-already-applied paths into one. `0 < fresh.length <
wrappedUpdate.updates.length` is the new path that fixes the bug.

## Reproducer

The `moth-wallet` repo carries a client-side workaround that proves the fix:
[packages/core/src/sync/sdk-dedup.ts](../../packages/core/src/sync/sdk-dedup.ts)
wraps `applyUpdate` via `V1Builder.withSync(...)`. With the wrapper installed,
preprod resyncs of large wallets complete without the WASM rejection;
without it, the rejection fires within seconds.

Tests covering the boundary, prefix-overlap, and full-overlap cases live in
[packages/core/tests/unit/sync/sdk-dedup.test.ts](../../packages/core/tests/unit/sync/sdk-dedup.test.ts).

## Note for upstream

The wrapper uses the `V1Builder.withSync(syncService, syncCapability)`
documented extension point — exactly the right surface for clients that need
to compose around the SDK's defaults. Keep that public API stable; it's how
moth-wallet bridges to the fix until upstream lands.
