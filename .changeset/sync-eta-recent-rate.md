---
'@shieldedtech/moth-wallet': patch
---

Measure the sync ETA from recent progress, not from the start of the session.

A fresh mainnet wallet reported "~2 h 8 min left" at 40% and finished nine
minutes later. The rate behind the estimate was measured from the session's
first sample, which treats the whole run as one rate — and a replay has no one
rate. The DUST walk is starved while the shielded walk runs beside it (about 25
events/s against 1,500/s once alone), so the early rate overstated the remaining
time twenty-fold, and the estimate shrank only as slowly as those early samples
lost weight.

The rate is now measured over a sliding window of about three minutes, which is
emptied whenever the set of sub-wallets still replaying changes, since that is
where the rate jumps. While two sub-wallets replay at once no ETA is shown: the
one behind is starved, and its rate predicts nothing about how fast it will run
once the other finishes. A sync that genuinely starts from zero likewise shows no
estimate until it has a few seconds of rate to measure, where it previously
extrapolated from its first percent.

The estimate is also a countdown now, not a reading. Within a phase the pace is
uneven — the DUST walk arrives in bursts and slows over the sync — and an
estimate that followed it read 3 min, 2, 1, then 2 and 3 again while the bar
barely moved. The rate is now the slowest 30-second bin in the window, the
estimate is stretched by half before it becomes the deadline, and the deadline
only moves earlier freely: it moves later only when the fresh estimate exceeds
what is shown by a wide margin for half a minute. On a mainnet sync it showed
282 s where 273 remained and 38 s where 33 did, never rising in between.
