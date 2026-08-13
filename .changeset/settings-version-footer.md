---
"@shieldedtech/moth-extension": patch
---

Show the real version in Settings, instead of "Moth 1.0".

The footer read `Moth 1.0 · Your keys never leave this device`. Two problems in
one line.

The version was wrong, and had been through eleven releases — the extension is
at 0.11.0. A hardcoded version string has no mechanism to stay true, so it drifts
from the first release onward. It now reads
`browser.runtime.getManifest().version`, which cannot.

The claim was dropped rather than reworded. It is broadly accurate — keys are
derived and dropped, and the keystore never leaves the device — but an
unqualified security assurance sits badly on a wallet that says elsewhere, at
some length, that it is unaudited, unsupported and for development. The mainnet
gating exists to make exactly that point. A footer quietly asserting the opposite
undercuts it.

Keeping a version display rather than removing the footer entirely: the
bug-report template asks reporters for "Version / commit", and this was the only
place in the UI showing one.

Adds a **Copy diagnostics** button under a new Support section, producing a
markdown block for bug reports: wallet version, browser, OS, network, whether
endpoints are overridden and to what, prover type, auto-lock, developer mode,
and pre-seed reference state.

What it excludes matters more than what it includes, because a user pastes this
into a public issue without auditing it first. No addresses, account names,
balances or key material — the input type has no field for any of them, so a
later edit to the renderer cannot leak one by accident. The node auth header is
reported as set or not set, never by value; it is a shared secret. Any userinfo
in a URL is stripped, since `https://user:pass@host` is a credential wearing a
URL's clothes. The output says so on its last line, so a reader can trust it at
a glance rather than reading it line by line.

The redaction rules are a pure function with 12 tests, since that is the part
worth getting right.
