---
'@shieldedtech/moth-tui': minor
---

Reveal a wallet's recovery phrase from the TUI keys screen (`p`).

The mnemonic was shown exactly once, during onboarding, on a screen that told
the user "This is the only time these words will be shown" — true for the TUI
and no other surface. Onboarding now says the words can be shown again from
the Keys screen. Core has had `exportPhrase`/`exportSeedHex` throughout,
the extension exposes it on the Accounts screen, and the CLI got
`wallet export-phrase` in #59. The TUI was the last surface where a wallet it
created itself had no backup path, while the same screen would delete that
wallet on a single keystroke.

The flow mirrors the CLI's: confirm first, because the failure mode is a phrase
left on a screen someone else can see; then the passphrase, which is asked for
even when the wallet is already unlocked. That is not redundant: D-KM-2 puts
seed export through the keystore, so an unlocked wallet left on screen is not
enough to reveal its phrase. The screen says so rather than looking like a
bug. Pressing ESC while the keystore is being decrypted cancels the reveal, so
the phrase never appears; Meta-key shortcuts (Meta+P pauses sync) no longer
open the prompt; and only a failed decryption is reported as a wrong
passphrase. The words are shown four to a row, so the grid fits an 80-column
terminal. A wallet imported from a hex seed is shown its seed
and told it has no phrase, instead of being handed 128 hex characters labelled
"recovery phrase". ESC or Enter takes the secret back off the screen and drops
it, along with the passphrase, from component state.
