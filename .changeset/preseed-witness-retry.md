---
'@shieldedtech/moth-wallet': patch
---

A new wallet keeps its pre-seed when one check of the reference fails to reach
the indexer.

Before using the bundled reference, the wallet re-reads the event its cursor
was witnessed at, to be sure the indexer has not renumbered its events since.
That read was a single websocket attempt, and a dropped connection or a quiet
socket refused the reference, so the wallet scanned the chain from genesis. On
CI the iOS app's first socket to the preview indexer failed this way on most
fresh installs, while the same read from a desktop returned the witnessed event
every time; the genesis scan then outran the UI tests' sync timeouts.

The read is now retried twice, after 2 s and 5 s, when it errors or returns
nothing. An event that comes back is compared at once, so a renumbered stream is
still refused on the first read, and a reference whose check never completes is
still refused.
