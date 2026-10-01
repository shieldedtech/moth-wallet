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

The rate is now measured over a sliding window of about 90 seconds, which is
emptied whenever the set of sub-wallets still replaying changes, since that is
where the rate jumps. While two sub-wallets replay at once no ETA is shown: the
one behind is starved, and its rate predicts nothing about how fast it will run
once the other finishes. A sync that genuinely starts from zero likewise shows no
estimate until it has a few seconds of rate to measure, where it previously
extrapolated from its first percent.
