---
"@shieldedtech/moth-extension": patch
---

Say what the wallet is on the first screen: a developer wallet for Midnight.

The welcome panel and setup tab opened with **"Money, but private."** Both halves
of that were claims the wallet does not keep.

There is no money. `DEFAULT_SETTINGS` puts a fresh install on preprod, and the
comment above it says why: the wallet is unaudited and for development, so a new
install must not land on a network carrying real value. The first screen was
promising money immediately before a deliberate decision to keep the user away
from any. What they actually hold is tNIGHT.

Privacy is not unconditional. This wallet holds a shielded *and* an unshielded
sub-wallet, and unshielded balances and transfers are public on chain. "but
private." made an absolute promise on the screen before the user learns there
are two kinds of address — the intro line beneath it was already more careful
("with your details shielded"), but the 72px headline is what gets read.

It now reads **"Your wallet for Midnight."**, describing the tool rather than
making a claim on the network's behalf, with the qualification below the buttons
where it belongs: unaudited, built for development, new wallets start on a test
network. Under the buttons rather than in the headline, so it qualifies the
offer instead of competing with it.

Both screens also stop naming mainnet's assets. `nativeAssetLabelsForNetwork`
was called with a hardcoded `'mainnet'`, so the intro said "hold NIGHT" on a
screen whose own button creates a wallet on preprod holding tNIGHT. There is no
selected network before a wallet exists, so the honest thing to name is the one
the next step will use — `DEFAULT_SETTINGS.network`.

Translations updated. The French line one is "Portefeuille" rather than "Votre
portefeuille": the setup tab sets the first line at 72px in a 520px column, and
eighteen characters there wrap into a third line the layout is not built for.
