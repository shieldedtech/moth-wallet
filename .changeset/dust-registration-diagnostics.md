---
"@shieldedtech/moth-extension": patch
---

Stop reporting a DUST registration that never happened, and show why.

A registration that registers nothing resolves normally — it returns no
transaction hash rather than throwing. The timings log recorded "complete" for
anything that did not throw, so a wallet which submitted nothing at all wrote
`tx: register complete`, indistinguishable from a real registration. A log
showing two of those, with NIGHT flat and DUST at zero for thirteen minutes,
therefore said the opposite of what had happened.

The label now names the outcome: `submitted`, `no-op (fee not affordable yet)`,
or `no-op (no available unregistered NIGHT)`. The two no-ops are kept apart
because they have different causes and different fixes — one resolves by
waiting, the other by settling a stuck transaction — so folding them together
would only move the ambiguity somewhere else. No transaction hash is recorded:
the timings page promises labels and durations only, and a hash is
chain-linkable to the wallet.

"Your NIGHT is not available to register right now" is raised when there is no
available *unregistered* NIGHT while the wallet still shows a balance. Those are
different numbers. The displayed balance folds in **booked** coins — inputs
reserved by a transaction that has not settled — so a wallet can read 500 NIGHT
and have nothing to register. Telling "all booked" apart from "all already
registered" meant opening the TUI, the only surface carrying per-coin flags.

The DUST screen now offers a per-coin breakdown: each NIGHT coin as generating,
not registered, or booked, with the booked total named explicitly. Values only —
no UTXO ids, addresses or nonces: enough to explain the balance, not enough to
identify a coin on chain. Collapsed by default, since it answers a question most
people never ask and the fetch reaches the offscreen host.
