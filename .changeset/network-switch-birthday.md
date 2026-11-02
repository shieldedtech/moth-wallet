---
'@shieldedtech/moth-extension': patch
---

A wallet created in the extension keeps its pre-seeded sync when it moves to
another network.

The background read the destination network's chain tip and sent it as the
wallet's birthday there, but the offscreen dispatch dropped the argument on its
way to the host. With no birthday the pre-seed guard (`reference.height <=
birthday`) can never pass, so the first sync on the new network scanned from
genesis. The host parameter is optional and positional, which is why the type
checker did not catch it; `tests/host-dispatch.test.ts` now does.
