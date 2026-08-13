---
"@shieldedtech/moth-extension": patch
---

Show the DUST meter when a wallet holds DUST but no NIGHT or tokens.

DUST is earned by registering NIGHT, not received, so it outlives the NIGHT that
generated it — after spending, or while a transfer is in flight, a wallet can
hold DUST and nothing else. The panel treated that as an unfunded wallet: it hid
the meter and showed the "add your first NIGHT" prompt, reporting a balance of
nothing while the total was demonstrably non-zero.

The `fresh` flag is deliberately unchanged. It also disables Send, and with no
NIGHT there is genuinely nothing to send — so the funding prompt stays and Send
stays disabled. Only the meter's visibility is separated out, because that is
what was actually wrong.
