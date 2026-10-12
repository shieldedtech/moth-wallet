---
'@shieldedtech/moth-extension': patch
---

Using a connected dApp now counts as activity for the auto-lock, and the
default inactivity window is one hour.

The inactivity clock was reset only by the side panel — opening it, clicking or
typing in it. A user working in a dApp with the panel closed produced no
activity at all, so the wallet locked out from under them mid-session as soon as
the window elapsed between two requests; only an operation actually in flight
was protected. Every successful connector request from a connected origin now
records activity, so a dApp session stays unlocked for as long as it keeps
talking to the wallet. Requests from origins the user has not connected, and
requests that fail, do not count.

The default window moves from 15 minutes to 1 hour. Installs that have saved an
explicit choice keep it.
