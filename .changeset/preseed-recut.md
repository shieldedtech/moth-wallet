---
'@shieldedtech/moth-extension': patch
---

New preprod wallets start at the chain tip again instead of walking from
genesis. The bundled preprod pre-seed reference was cut against the
decommissioned indexer, and the new indexer numbers its shielded events
differently, so every new wallet refused it and synced from genesis, which took
about an hour. The reference is now cut against the new indexer, at height
2,969,772, and a fresh preprod wallet is synced in seconds. The preview
reference is refreshed to its current tip as well.
