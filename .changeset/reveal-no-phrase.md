---
'@shieldedtech/moth-extension': patch
'@shieldedtech/moth-wallet': minor
---

**Reveal no longer offers a recovery phrase for accounts that do not have one.**

The first version accepted either choice and then answered with the seed for a
seed-restored account, because that account genuinely has no phrase — BIP-39's
phrase-to-seed step is one-way, so one cannot be worked back out. Correct
values, but it read as the selection being ignored: pick "recovery phrase", get
a hex seed, with the explanation arriving only after the password was entered.

The phrase option is now disabled for those accounts, with the reason shown
next to it, and the dialog opens on the seed instead.

To grey it out *before* asking for a password, the UI has to know which artifact
an account holds. `WalletInfo.backupKind` (`'mnemonic' | 'seed'`) records it:
`generate` and `import` write `'mnemonic'`, `importFromSeed` writes `'seed'`.

`undefined` on accounts written before the field, and deliberately not defaulted
— guessing `'mnemonic'` would tell a seed-imported account it has a phrase,
which is the bug this exists to prevent. Unknown leaves the option open and lets
the revealed value explain itself as before. **`unlock` backfills the field**,
since the keystore payload (`seed:<hex>` versus a mnemonic) is what distinguishes
them and the password is the only thing that reveals it — so an account someone
actually opens stops being unknown after one unlock. The write happens only when
the stored value is missing or wrong, alongside the address backfill already
there, so a normal unlock does not touch storage.
