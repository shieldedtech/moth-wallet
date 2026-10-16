---
'@shieldedtech/moth-extension': patch
---

Reject an empty transaction on the dApp connector with `InvalidRequest`.

`submitTransaction`, `balanceSealedTransaction` and `balanceUnsealedTransaction`
accepted `''` (or a missing argument) as valid hex. A balance call then showed
the user an approval with unknown amounts, and both paths failed only in the
ledger, as `InternalError`, after a wallet sync. They now refuse it before any
prompt or wallet work, as the connector spec asks for a malformed transaction.

Also adds connector conformance tests: the spec error shape, the announced
method list and API version, permission and lock gating for every method, and
the previously untested `getUnshieldedAddress`, `getDustAddress` and
`submitTransaction`.
