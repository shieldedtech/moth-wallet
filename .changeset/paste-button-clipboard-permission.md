---
'@shieldedtech/moth-extension': patch
---

Declare `clipboardRead`, so the Paste button on a recipient address works
outside Chrome.

Both Paste affordances — the one on the recipient field in Send and the DUST
designation dialog (`components/moth/address-picker.tsx`), and the seed-phrase
one in setup — call `navigator.clipboard.readText()`, but the manifest never
asked for the permission that read requires. Chrome serves the read to an
extension page off a user gesture regardless of whether it was declared, so the
omission was invisible there and the buttons worked. Stricter Chromium builds
enforce the declaration: on Brave the promise rejected, and the picker's
`catch` discarded the rejection without touching the field or saying anything,
so Paste was a button that did nothing.

The rejection is now logged rather than swallowed. It still leaves the field
alone — a keyboard paste was never affected and remains the fallback — but a
refused read raises no UI of its own, so silence made a permission problem
indistinguishable from a dead button.

A guard test resolves the manifest for both targets and asserts the permission
is present, since the only builds that would otherwise notice its absence are
the ones we do not test on.
