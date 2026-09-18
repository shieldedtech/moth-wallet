---
'@shieldedtech/moth-extension': patch
---

Stop the panel's first paint and dApp approval prompts from waiting behind the
sync engine's cache restore.

A cold start of the offscreen wallet worker restores the account's sync caches
with long synchronous WASM calls — a synced preprod account's dust state alone
is ~50 s to deserialize in Node and longer in the browser — and while one runs,
nothing else on that thread does. Two requests were queued behind it that have
nothing to do with sync: `walletList`, the IndexedDB read the side panel needs
before it renders anything (so the panel was black for the duration), and
`txSummary`, the pure ledger decode behind a dApp's approve/reject prompt (so a
dApp transaction sat for a minute or two before the user was even asked). Since
0.13.0 the idle teardown closes the worker 10 s after the panel closes, so every
interaction after a short pause paid the full restore again.

The offscreen page now runs a second instance of the same worker script as a
"fast lane" for exactly those two stateless methods (`host-dispatch.ts`
`laneFor`); the first keeps the sync engine and everything that needs it. The
panel paints, and the approval prompt appears, as soon as the fast worker has
loaded — seconds, not the restore — while balancing still waits for sync as
before. The lane split is pinned by a test: widening it is a deliberate
decision, since the fast worker holds its own copy of every module-level
variable in wallet-host.
