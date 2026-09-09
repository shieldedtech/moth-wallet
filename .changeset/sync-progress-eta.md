---
'@shieldedtech/moth-extension': patch
---

Stop the sync indicator claiming more than it knows.

**A rebuild was reported as "Synced".** The regression grace held "Synced" and
forced every displayed percentage to 100 after any regression. That is right for
an ordinary tip advance, which dips a fraction of a percent. It is wrong for a
cache rebuild, which drops progress to near zero — the user asked for the
rescan, and the UI answered that there was nothing to do. The hook now takes the
raw fraction and reports a drop below 90% immediately, treating only small dips
as noise. Applied to all three call sites, so the DUST rebuild — which had the
same latent bug — is fixed too.

**The ETA existed and was being thrown away.** `SyncProgress.etaSeconds` was
already baseline-corrected for resumed syncs and already reached the extension,
which then dropped it; the CLI showed it. A rescan with no duration signal
leaves no way to tell a slow job from a stuck one, so it now appears beside the
percentage.

It is deliberately coarse — five-second buckets under 90s, then whole minutes —
because it is a rate extrapolation and finer precision would imply accuracy it
does not have. Suppressed when not estimable rather than showing a misleading
`0s`, and hidden while synced so an ETA never sits beside a completion state.
