# Mobile

Work toward running moth on phones. Nothing here is part of the published packages or the yarn workspace.

| Directory | What it is |
|---|---|
| [`ios/`](ios/README.md) | Moth for iPhone. A SwiftUI app that runs moth's extension wallet worker, unchanged, in a hidden WKWebView, with proofs made on the phone by the native Rust prover and keys behind Face ID in the Keychain. Preprod only. |
| [`proving-bench/`](proving-bench/README.md) | iPhone benchmark for native Midnight proving. Wallet circuits take 1.2–2.4 s, and contract circuits fit in memory up to k=17. |

**Finding:** the published `@midnight-ntwrk/ledger-v8` 8.x WASM takes about a minute to restore a preprod wallet's cached DUST state, because its deserializer is quadratic. The same release built from source with the upstream fix (which no published 8.x includes) takes under a second. This affects the extension, TUI and CLI too, not just mobile. See [DUST restore time](ios/README.md#dust-restore-time).
