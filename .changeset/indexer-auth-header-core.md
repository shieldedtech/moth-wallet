---
'@shieldedtech/moth-wallet': minor
---

An operator-issued header on every indexer request.

The public indexers sit behind an edge that rate-limits by source address:
three daemons on one host, plus midnight-js polling for inclusion, were enough
for preprod's to answer HTTP/2 403 (`server: awselb/2.0`) under normal
operation. Pool operators hold an exemption header, and nothing in moth
accepted one — they had to wrap the process's `fetch` and `WebSocket` by hand
and push a `--import` preload into each daemon through NODE_OPTIONS.

`NetworkConfig.indexerAuthHeader` (`{name, value}`) now carries it, beside the
existing `nodeAuthHeader`. In Node, `installIndexerAuthHeader` applies it once,
process-wide, to requests whose origin is the indexer's and no other: a `fetch`
wrapper, and — because the runtime's own WebSocket cannot send handshake
headers — a `ws` subclass installed as the global WebSocket and handed to
midnight-js's `indexerPublicDataProvider`. That covers the four clients that
talk to the indexer from one process (moth's IndexerClient, the wallet SDK's
graphql-http and graphql-ws clients, midnight-js's Apollo links), none of which
takes headers through its own configuration. `startWalletSync` installs it
from the network config. The header is a shared secret: never logged, never in
diagnostics.
