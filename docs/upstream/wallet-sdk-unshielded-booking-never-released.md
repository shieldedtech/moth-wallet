# A leaked unshielded booking gets duplicated into both UTXO maps, and the balance doubles

Target: `@midnightntwrk/wallet-sdk-unshielded-wallet` (`packages/unshielded-wallet`), with a contributing gap in `@midnightntwrk/wallet-sdk-facade` (`packages/facade`).

Tested against `wallet-sdk-unshielded-wallet@3.1.0`, `wallet-sdk-facade@4.1.0`. Source line numbers are from `main` at `6e1050e`, where both are unchanged.

## Symptom

A wallet holding only unshielded NIGHT reports **exactly twice** its on-chain balance (6,000 displayed against 3,000 on chain) and keeps doing so across restarts. DUST registration then reports success without doing anything, and the register and deregister views both show "none available". No request reaches the proof server.

The persisted state has the same UTXO in both maps at once:

```json
"availableUtxos": [ { "intentHash": "421c4146…", "outputNo": 0, "value": "3000000000" } ],
"pendingUtxos":   [ { "intentHash": "421c4146…", "outputNo": 0, "value": "3000000000" } ]
```

Deleting the persisted state is the only recovery.

## The invariant

`availableUtxos` and `pendingUtxos` are disjoint by construction. `spend()` moves a UTXO between them — `unshielded-wallet/src/v1/UnshieldedState.ts:55-66`:

```ts
spend: (state, utxo) =>
  Either.gen(function* () {
    const hash = UtxoHash(utxo.utxo);
    if (!HashMap.has(state.availableUtxos, hash)) {
      return yield* Either.left(new UtxoNotFoundError({ utxo: utxo.utxo }));
    }
    return {
      availableUtxos: HashMap.remove(state.availableUtxos, hash),   // removed here
      pendingUtxos: HashMap.set(state.pendingUtxos, hash, utxo),    // added here
    };
  }),
```

Every balance accessor depends on that. `CoinsAndBalances.ts:41-67` sums each map independently (`getAvailableCoins`/`getPendingCoins` return the raw `HashMap` values — no subtraction), and `getTotalBalances` adds the two. `UnshieldedWallet` exposes the available side as its headline number, `unshielded-wallet/src/UnshieldedWallet.ts:68-70`:

```ts
get balances(): Record<ledger.RawTokenType, bigint> {
  return this.capabilities.coinsAndBalances.getAvailableBalances(this.state);
}
```

So a UTXO in both maps is counted twice by `getTotalBalances`, and is reported as spendable by `balances` while also being reported as booked — inside the SDK, before any consumer code runs.

## Defect 1 — `applyUpdate` re-adds a UTXO that is currently booked

`UnshieldedState.ts:98-120` unions the update's `createdUtxos` into `availableUtxos` with no check against `pendingUtxos`:

```ts
return {
  availableUtxos: HashMap.union(
    HashMap.removeMany(state.availableUtxos, update.spentUtxos.map((utxo) => UtxoHash(utxo.utxo))),
    HashMap.fromIterable(update.createdUtxos.map((utxo) => [UtxoHash(utxo.utxo), utxo])),
  ),
  pendingUtxos: HashMap.removeMany(state.pendingUtxos, update.spentUtxos.map((utxo) => UtxoHash(utxo.utxo))),
};
```

The indexer-backed sync capability (`Sync.ts:103-135`) feeds `createdUtxos` straight from the `unshieldedTransactions` subscription, so any replay of the transaction that created a currently-booked UTXO puts that UTXO back into `availableUtxos` while it is still in `pendingUtxos`.

**The SDK already has this guard elsewhere.** The simulator sync capability does exactly the check the indexer path omits, `Sync.ts:208-212`:

```ts
// Created: in simulator but not in wallet (neither available nor pending)
const createdUtxos = Array.from(simulatorUtxoMap)
  .filter(
    ([hash]) => !HashMap.has(state.state.availableUtxos, hash) && !HashMap.has(state.state.pendingUtxos, hash),
  )
```

`restore()` (`:50-53`) does not check disjointness either, so once written the duplicate survives every restart and no amount of resyncing clears it.

## Defect 2 — a booking is only released through the submit path

Inputs are booked during **balancing**, not submission — `Transacting.ts:346` and `:558` both call `CoreWallet.spendUtxos(...)` while building the offer. Release happens in exactly three places, all downstream of submission:

1. `facade.submitTransaction` reverts in its catch — `facade/src/index.ts:772-787`:

```ts
try {
  await this.pendingTransactionsService.addPendingTransaction(tx);
  const key = submitTxHistoryKey(tx);
  await this.#txHistoryStorage.gotPending({ ...key, submittedAt: this.clock.now() });
  await this.submissionService.submitTransaction(tx, 'Finalized');
  return identifiers.at(-1)!;
} catch (error) {
  await this.revert(tx);
  throw error;
}
```

2. The pending-transaction watcher reverts failures — `facade/src/index.ts:565-571`:

```ts
this.#pendingSubscription = this.pendingTransactionsService
  .state()
  .pipe(
    concatMap((pending) => PendingTransactions.allFailed(pending)),
    concatMap((item) => this.revert(item.tx)),
  )
  .subscribe();
```

3. `applyFailedUpdate` (`UnshieldedState.ts:122-141`) returns inputs on an on-chain `FAILURE`.

All three require the transaction to have reached submission, and (2) and (3) require an on-chain result: `allFailed` selects only items whose `result.status` is `FAILURE` or `PARTIAL_SUCCESS` (`capabilities/src/pendingTransactions/pendingTransactions.ts:67-74`). Nothing reaps a booking on a TTL or reconciles pending entries against chain state.

That leaves two windows where a booking leaks permanently:

- **Booked but never submitted.** Balancing succeeds, then proving fails — in our case a proof server running a mismatched ledger version — or the process dies. No pending entry was ever created, so no revert path can see it.
- **Submitted but never resolved.** The transaction is accepted for submission but never lands and never gets a result. Nothing expires it.

A caller *can* call `facade.revert(recipe)` itself, and that is the documented escape (`facade/src/index.ts:1345-1352`). But nothing in the SDK's surface signals that a booking is outstanding, so a caller that misses one — or a process that dies before it can — has no way back: the booking is unspendable and, via Defect 1, becomes a double-count on the next resync.

## How the two combine

1. UTXO `U` is in `availableUtxos`.
2. Balancing books it: `spend()` moves it to `pendingUtxos`. The balance is still correct — `getAvailableBalances` no longer counts it.
3. Proving fails. Nothing reverts (Defect 2), so `U` stays pending forever.
4. A later sync replays the transaction that *created* `U` — a restore from a cursor predating it, or a resubscription from an earlier `appliedId` — and Defect 1 re-adds `U` to `availableUtxos`.
5. `U` is now in both maps. `getAvailableBalances` counts it and `getPendingBalances` counts it, so `getTotalBalances` doubles. Consumers that add pending to available (to avoid flashing the balance to zero mid-booking) double it too. Coin selection that excludes booked UTXOs still finds nothing to spend — so the wallet simultaneously reports twice the money and nothing available.

## Reproduction

1. Fund a fresh wallet with unshielded NIGHT only — no shielded history keeps the failure isolated to this state machine.
2. Point it at a proof server running a different ledger version than the node, so proving fails deterministically.
3. Build a transaction that books an input (a transfer, or a DUST registration) and let proving fail. Do not call `facade.revert`.
4. Restart so the wallet restores from persisted state and resyncs from its cached cursor.
5. The persisted state now has one `intentHash`+`outputNo` in both `availableUtxos` and `pendingUtxos`, and the reported balance is doubled.

## Suggested fixes

**Defect 1** — give the indexer path the guard the simulator path already has:

```diff
       return {
+        // A created UTXO that is currently booked must not re-enter availableUtxos:
+        // the maps are disjoint by construction (see `spend`) and every balance
+        // accessor counts them independently.
         availableUtxos: HashMap.union(
           HashMap.removeMany(
             state.availableUtxos,
             update.spentUtxos.map((utxo) => UtxoHash(utxo.utxo)),
           ),
-          HashMap.fromIterable(update.createdUtxos.map((utxo) => [UtxoHash(utxo.utxo), utxo])),
+          HashMap.fromIterable(
+            update.createdUtxos
+              .filter((utxo) => !HashMap.has(state.pendingUtxos, UtxoHash(utxo.utxo)))
+              .map((utxo) => [UtxoHash(utxo.utxo), utxo]),
+          ),
         ),
```

`restore()` deserves the same treatment: dropping an entry present in both maps repairs already-persisted state on load instead of carrying it forward forever. That alone would have turned this from "unrecoverable without deleting the cache" into "self-heals on next start".

**Defect 2** — in increasing order of completeness:

1. Reconcile on sync: a pending UTXO that the indexer still reports as unspent, whose booking has no corresponding pending transaction, was never spent. This is the case Defect 1's guard cannot fix, because there is nothing to guard against — the booking itself is stale.
2. Expire bookings on a TTL, the way transactions already have one. A booking outliving its transaction's TTL cannot still be valid.
3. Surface outstanding bookings on the public API, so a consumer can at least detect and release them. Today `pendingCoins` shows the coins but not which transaction booked them or whether that transaction still exists.

## Note for consumers

Two things bit us that are worth stating plainly for anyone else on this API:

- Bookings are taken at **balance** time, so any failure between balancing and submission must be followed by an explicit `facade.revert(recipe)`. We had this right in our fee-estimation path (which reverts in a `finally`) and wrong in the transfer and registration paths, which is how we produced the leak.
- `balances` is the **available** map only, so a consumer that wants "what this wallet owns" has to add `pendingCoins` back — and that addition is what turns a duplicated UTXO into a visibly doubled balance. A consumer doing this should skip any pending UTXO whose `intentHash#outputNo` also appears in `availableCoins`, and warn: the duplicate is trivially detectable at read time, and would have saved us a two-hour investigation.
