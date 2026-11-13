---
'@shieldedtech/moth-extension': patch
---

Saving a setting no longer freezes every other setting at its current default.

`updateSettings` merged the caller's patch into the fully *resolved* settings and
wrote the result, so the first write persisted all six keys — including the ones
the caller never mentioned, carrying whatever the defaults happened to be. Every
unlock performs such a write (it saves the account's network), so any install
that had been unlocked once held a complete settings object, and changing a
default in code could never reach it. That is why raising the auto-lock default
to an hour had no effect on existing installs.

Writes now merge into the stored object rather than the resolved one, so a key
nobody has set stays absent and keeps tracking the default. An explicitly saved
value — including `null` for demo mode — is still honoured and still wins.

Existing installs keep the auto-lock value already written to their storage,
which for most is the old 15 minutes; it can be changed in Settings. Values are
deliberately not migrated: raising someone's lock timeout without asking would
weaken a security setting they may have chosen on purpose.
