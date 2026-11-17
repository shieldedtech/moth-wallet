---
'@shieldedtech/moth-extension': patch
---

Mainnet can be chosen during first-run setup.

The setup tab's network step hid mainnet behind developer mode and told the
user to turn it on in Settings, but Settings is only reachable once an account
exists. Choosing mainnet meant creating an account on another network first,
waiting for it to start syncing, enabling developer mode, then switching. The
notice under the network list now has its own "Turn on Developer mode" button,
on the setup step and in Settings → Network alike.

Choosing mainnet during setup now asks for the same real-funds acknowledgement
that Settings → Network already required.
