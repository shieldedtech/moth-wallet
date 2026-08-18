---
'@shieldedtech/moth-wallet': minor
---

Handle both ledger signature encodings, and report the signature kind.

Ledger v8 types `Signature` and `SignatureVerifyingKey` as bare hex strings;
v9 types them as `{tag, value}`, where the tag selects BIP-340 Schnorr or ECDSA
over secp256k1. `signMessage` previously passed both through `String()`, which
is identity on v8 and yields `"[object Object]"` on v9 — a value well-formed
enough to look like a signature and wrong enough never to verify.

New `unwrapSignatureValue` and `signatureKindOf` accept either encoding.
`SignedMessage` gains a `signatureKind` field, reported as `schnorr` on v8,
which has no other kind.
