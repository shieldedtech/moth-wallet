---
'@shieldedtech/moth-extension': patch
---

Keep the underscores in an address visible, by naming a real monospace face
ahead of the generic one.

`--font-mono` ended in `ui-monospace, 'SF Mono', Menlo, monospace`, which lists
only faces that exist on macOS. Everywhere else it fell through to the generic
`monospace`, which on most Linux desktops resolves to DejaVu Sans Mono — and
inside an `<input>` at 14px Chromium renders that face's underscore as no
pixels at all, so `mn_addr_undeployed1…` read as `mn addr undeployed1…`. An
address is exactly the string where a silently dropped character matters.

The loss is specific to the combination: the same face renders the underscore
in a plain element, and at 13px or 15px in the same input. Line-height,
padding and box height do not move it, so the font stack is the only lever.
Consolas covers Windows and Liberation Mono and Noto Sans Mono cover Linux,
each of which renders the underscore at every size in the 12–16px range.
