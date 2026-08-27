---
'@shieldedtech/moth-extension': patch
---

Give a hung sync a way out, not just a failed one.

The loading screen shown after create/restore/unlock only offered "Change
network" once a sync had thrown — a message prefixed `Sync failed:`. A sync
that hangs without ever throwing (the wrong network selected, an unreachable
endpoint, or a subsystem whose progress reads 100% but never flips `isSynced`)
left the panel showing "Getting things ready" forever, with no error and no
way to reach Settings -> Network: the router shows only this screen until a
balance snapshot arrives, so there was no route out.

`WalletLoading` now takes a `slow` prop; once a wait has held for 20s without
a balance snapshot, it shows the same "network unreachable" hint and "Change
network" action the failure path already had. A new `useSlowSync` hook in
`lib/ui/client.ts` times it and resets whenever the wait ends.
