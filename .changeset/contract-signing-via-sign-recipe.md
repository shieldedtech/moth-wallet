---
'@shieldedtech/moth-wallet': patch
---

Sign contract transactions through `facade.signRecipe`, so unshielded inputs reach the node signed.

The contract paths signed by hand, ending each intent with
`tx.intents.set(segment, signedIntent)` and discarding the result.
`Transaction.intents` is a WASM getter that builds a fresh JS Map on every read,
so this mutated a throwaway copy and the signature never reached WASM. Any
circuit producing unshielded UTxO inputs — anything calling `receiveUnshielded`
— was submitted with those inputs and zero signatures, and the node rejected it
with `1010 Invalid Transaction: Custom error: 192`
(InputsSignaturesLengthMismatch).

All four sites (call, deploy, and both maintenance paths) now call
`facade.signRecipe`, which returns a new recipe rather than mutating in place —
the same call the transfer path has always made. It also selects the right
signer per transaction type and stamps DUST registration signatures, neither of
which the hand-rolled helper did. The three copies of that helper are deleted.

`deploy` was never affected, because it spends only DUST on fees, which is why
the failure looked specific to `call`.
