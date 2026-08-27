---
'@shieldedtech/moth-wallet': minor
---

Persist a wallet's signature kind, and derive addresses from it.

`deriveAllAddressesFromSeed` takes a `SignatureKind` (default `schnorr`, so
existing wallets are unchanged), and `WalletManager.generate` accepts and stores
it. Only unshielded addresses depend on the kind — shielded and DUST are
identical either way.

ECDSA exists only on ledger v9, so an ECDSA wallet gets no unshielded address on
a v8 network rather than one that could never receive.

The kind is fixed at creation: `DustRegistration` binds the tagged night key, so
changing it would strand NIGHT at the old address and stop DUST generation until
re-registered.
