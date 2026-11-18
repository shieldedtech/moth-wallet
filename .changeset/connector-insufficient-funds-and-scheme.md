---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-browser': minor
'@shieldedtech/moth-extension': minor
---

Use what `@midnight-ntwrk/dapp-connector-api` 4.1.0 added: the
`InsufficientFunds` error code and `Signature.scheme`. The extension now
advertises `apiVersion` 4.1.0.

A connector request the wallet cannot fund now rejects with
`InsufficientFunds` instead of `InternalError`. That covers
`balanceSealedTransaction`, `balanceUnsealedTransaction`, `makeTransfer` and
`makeIntent`, whether the shortfall is a shielded or unshielded token or the
DUST fee. The connector recognises the wallet SDK's error by its tag
(`Wallet.InsufficientFunds`), which survives the trip out of the offscreen
worker where the error's class does not. A malformed request is still
`InvalidRequest`, and every other failure keeps the code it had.

The reason now names the token and the shortfall, as
`Insufficient funds [tokenType=…, amount=…]`, which it was meant to do already
and did not. The SDK's promise methods reject with Effect's `FiberFailure`,
whose only own field is its name. The SDK error, with its `_tag`, `tokenType`
and `amount`, sits behind a symbol, so the fields were dropped at the first hop
and the dApp received the bare message. The worker's error codec now hands on
the typed failure inside a `FiberFailure`. A defect has none, and stays
wrapped. The extension's own screens see the same errors with the
`(FiberFailure) ` prefix gone from their names. Their messages are unchanged.

`signData` results carry `scheme: 'schnorr_bip340'`. In core, `SignedMessage`
gains a `scheme` field, read off the ledger's signature tag, and core exports
the `SignatureScheme` type. The signature and key are unchanged: a 64-byte r‖s
signature and a 32-byte x-only verifying key, the formats 4.1.0 specifies for
that scheme. moth signs only with schnorr. An ECDSA signature would be named
`ecdsa_secp256k1_sha256`.
