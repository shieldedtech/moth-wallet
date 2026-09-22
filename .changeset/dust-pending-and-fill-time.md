---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-extension': patch
---

Hold the DUST balance steady while a fee is in flight, tell the truth about
when DUST fills, and log the fee a send actually pays.

Paying a fee moves the whole DUST coin out of the ledger's spendable set until
the transaction lands, and the change only arrives with the chain event, so the
displayed balance fell by the size of the coin rather than the size of the fee:
12,959.88 to 9,354.74 and back on a preprod send. With largest-coin-first
selection that is the largest drop available. Booked coins now count toward the
balance, as booked NIGHT inputs already did.

The fill-time estimate came from the SDK's `maxCapReachedAt`, which is the
coin's creation time plus the whole time-to-cap however full the coin already
is. Every spend gives the change coin a fresh creation time, so a wallet at 39%
was told "full in about 7 days" after each send. The meter's estimate now comes
from the meter: the fraction of the climb still ahead, at the rate the whole
registered balance generates. That wallet reads about 4 days. Reading the
slowest individual coin instead would not have helped, because every send
leaves a fresh change UTXO whose own coin starts low, pinning the estimate near
the full climb for any wallet in use.

The TUI shows a countdown per coin, where the remaining climb over that coin's
rate is the right answer, so `DustCoinInfo` now carries the coin's rate and the
shared `secondsUntilFull` replaces `maxCapReachedAt` there.

`startWalletSync` takes an `onDustFeePass` callback carrying each pass of the
DUST fee-balancing loop, and the extension logs it alongside the quote the
confirm screen shows. The preview and the real spend share the SDK's balancing
recipe, so both appear, which is what makes a quote that disagrees with the
spend visible without querying the chain.
