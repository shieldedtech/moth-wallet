---
'@shieldedtech/moth-wallet': patch
---

Report the real error when a contract artifact fails to load.

`loadContractArtifact` wrapped its whole `managed/contract/` branch in a
`try`/`catch` that discarded the error, so a module that existed but failed to
load was reported as `No contract module found in <path>`. The common cause is a
compact runtime version mismatch, whose own message names both versions and
points straight at the fix. Only a missing `contract/` directory now falls
through to the remaining strategies.
