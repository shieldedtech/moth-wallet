---
'@shieldedtech/moth-extension': patch
---

Send a dApp's prover key to the wallet once, not with every proof.

The connector's `getProvingProvider` proxy carried each contract circuit's full key material
with every `check` and `prove`, re-encoded as base64 JSON at each hop from the page to the
wallet host. compactc 0.36 writes prover keys uncompressed (22 MB for a small circuit, 98 MB
for a k=16 one), so a proof spent seconds moving its key before reaching the prover, twice
per proof, and a key above ~48 MB could not cross Chrome's 64 MiB message cap at all.

- The page now sends a prover key once, in 8 MiB chunks, and later requests name it by
  SHA-256. The wallet host checks the hash on arrival and holds keys per dApp origin, the
  least recently used going first beyond 512 MiB.
- A request naming a key the wallet no longer holds is refused, and the page sends the key
  and asks again. Concurrent proofs of one circuit share one upload.
- Outside a secure context, where the page has no `crypto.subtle`, requests carry their keys
  in full as before.
