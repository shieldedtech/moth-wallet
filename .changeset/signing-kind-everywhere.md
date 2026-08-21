---
'@shieldedtech/moth-wallet': patch
---

Sign with the wallet's own signature kind everywhere.

The four `contract/*` keystores and `signMessage` took a raw key rather than a
key bundle, so they defaulted to schnorr regardless of the wallet. An ECDSA
wallet would have signed contract calls and dApp `signData` requests with the
wrong key, publishing a verifying key it never gave out.

The contract paths take the kind from the bundle when one is supplied; the
legacy `seedHex` path has no kind to read and stays schnorr. `signMessage`
accepts the kind, and the extension's `signData` reads it from the wallet
record.
