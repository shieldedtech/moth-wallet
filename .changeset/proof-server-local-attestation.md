---
'@shieldedtech/moth-wallet': minor
'@shieldedtech/moth-cli': patch
---

Hold a remote proof server's witness until a local attestation session matches a stored measurement pin. The session comes from `@input-output-hk/veritee-attestation-verifier` 0.5.0.

A proof server on localhost stays on the plain client. Any other host needs a pin (`moth config set proof-server-pin '<json>'`, or `MOTH_PROOF_SERVER_PIN`) naming the attestation host plus launch measurement, image id, SVNs, PCR 0–4, and the application-disk root hash. `/check` and `/prove` run only after that session binds the TLS key. A quote mismatch or a missing pin leaves the witness in the wallet process. WASM proving is unchanged, and this slice does not call the Warden or read the Temenos ledger.
