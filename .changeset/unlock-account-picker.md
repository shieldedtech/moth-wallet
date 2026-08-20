---
'@shieldedtech/moth-extension': patch
---

Ask which account to unlock when there is more than one.

Deleting the active account left the password apparently rejected. Removal
promotes the next account to active, but silently: the unlock screen showed a
generic "Welcome back" with no indication the target had changed, so a correct
password for the account the user had in mind was rejected by a different one.

The screen now lists the accounts with their network, defaults to the active
one, and unlocks whichever is selected. A single account is unchanged.
