---
'@shieldedtech/moth-wallet': patch
---

Sign the maintenance-authority update through `signRecipe`, like every other
contract path.

`replaceAuthority` built its balanced transaction and then signed it with a
local `signTransactionIntents` helper, which walked `tx.intents`, rebuilt each
intent with its signature attached, and wrote it back with
`tx.intents.set(segment, cloned)`.

That write goes nowhere. `Transaction.intents` is a WASM getter that returns a
fresh `Map` on every read, so the `Map` being mutated is a copy that is
discarded the moment the expression ends. The transaction submitted is the
unsigned one, and the node rejects it:

```
error 192
```

The same trap was found and fixed on the insert-verifier-key path, which is why
`insertVerifierKey`, `insertVerifierKeys`, `deploy`, `call` and both transfer
paths already route through `facade.signRecipe` — it returns a *new* recipe
rather than mutating in place. `replaceAuthority` was the last caller still
doing it by hand, having been written before that fix landed and merged forward
without picking it up.

It now uses the same two lines as its neighbours, and the hand-rolled helper is
gone.

No test covers this: the CLI suite asserts only that `maintenance
replace-authority` renders its help, and the failure needs a node to reject the
submission, so the suite stayed green throughout. Confirming the fix needs a
real `replace-authority` run against a network.
