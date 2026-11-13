---
'@shieldedtech/moth-extension': patch
---

Show a token's name in the activity feed, not its id.

A feed row read `Sent to mn_shiel…z9e5  -2 24419f09…` for a token the asset list
already called `stNIGHT`, because the user had named it. The feed now uses that
name, in the amount and in the swap and received titles.

The id stays visible beside the name, as it is on the asset list: a token a user
names `tNIGHT` would otherwise produce a row indistinguishable from a real NIGHT
send.
