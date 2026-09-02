---
'@shieldedtech/moth-extension': minor
---

**Accounts → Reveal can now show an account's hex seed, not only its recovery
phrase.**

The 24 words cannot be expanded to their seed by hand — BIP-39's phrase-to-seed
step is PBKDF2 — so for a phrase-backed account the seed was simply unobtainable
from the extension, even though tooling that wants a seed rather than a phrase is
common. `walletExportPhrase` takes an `as: 'backup' | 'seed'` and the offscreen
host routes to `exportPhrase` or `exportSeedHex` accordingly.

The choice is made **before** the password is entered, not as a toggle on the
revealed value. Fetching both on one password entry would be the smoother
interaction and would put a secret on the page nobody asked to see; only the
artifact actually requested is decrypted. Both arms read the keystore with the
password just supplied and neither touches the unlocked session's key material,
per D-KM-2 in `docs/spec/wallet-service/05-key-management.md`.

The seed is deliberately **not** offered next to the phrase during wallet
creation. A phrase carries a BIP-39 checksum, so one wrong word is caught on
restore; a seed carries nothing, and one wrong character restores a different,
valid, empty wallet with no error at all. Presenting the two as equivalent
backups at the moment someone is writing one down would quietly downgrade the
backup. This is an interop and recovery-of-last-resort affordance, sited
accordingly.

An account restored from a hex seed has no phrase, so its `backup` arm returns
the seed and the existing view labels it as one — the choice self-corrects
instead of needing a stored "which kind" flag on the account.
