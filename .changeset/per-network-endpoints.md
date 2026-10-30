---
'@shieldedtech/moth-extension': patch
'@shieldedtech/moth-tui': patch
---

Keep each network's custom endpoints when switching networks, and add a reset to defaults.

The extension kept one set of custom node, indexer and prover endpoints, for the
selected network, and cleared it whenever the network changed: on the network
screen, and on unlocking an account that lives on another network. It now keeps
them per network, so switching away and back finds them again. Endpoints saved
before this change stay with the network they were saved for. The network screen
always shows "Reset to defaults", disabled while the endpoints are the defaults.

The TUI already kept endpoints per network; its network screen gains a Reset row
that restores the selected network's default endpoints.
