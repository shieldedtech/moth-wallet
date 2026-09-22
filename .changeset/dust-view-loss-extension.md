---
'@shieldedtech/moth-extension': patch
---

Offer the DUST records rebuild when the engine's chain check finds the view
incomplete, and say why.

The DUST screen already offered a rebuild on a capacity deficit older than the
grace period. It now also offers one when core's dust view check reports a
missing coin, a stalled cursor or a rejected replay, and shows the engine's
reason next to the note.
