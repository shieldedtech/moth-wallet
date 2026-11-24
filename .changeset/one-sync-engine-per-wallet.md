---
'@shieldedtech/moth-extension': patch
---

Run one sync engine per wallet when the network's endpoints change.

Changing a network's node, indexer or proof server while a dApp was asking for
balances could leave the engine for the old endpoints running beside the new
one. Both engines published into the same panel, so the balance and DUST meter
switched between two chains every few seconds, and both wrote the same sync
cache.

Engine starts and stops now run one at a time, a stop always reaches an engine
that is still starting, and only an engine that is still the active one can
publish balances. A dApp request keeps using the running engine; only the
wallet's own restart after a settings save moves it to new endpoints.
