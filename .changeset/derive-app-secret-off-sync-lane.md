---
'@shieldedtech/moth-extension': patch
---

Answer `deriveAppSecret` and `signData` promptly, drop a prompt whose page is gone, and show a prompt even when another extension has covered the Moth panel.

A dApp's `deriveAppSecret` could be approved and then answered tens of seconds
or minutes later, or never. Both seed-only connector methods ran on the wallet
worker that owns the sync engine, whose thread a cold start blocks for minutes
while it restores the account's sync caches (a synced preprod DUST state takes
~50 s to deserialize in Node, longer in the browser). A secret the user had
just approved sat behind that restore, and behind a wedged worker forever. They
now run on the second worker instance alongside `walletList` and `txSummary`,
and a request on that lane that goes unanswered for 60 s fails with a clear
error and respawns the worker instead of hanging until the page's timeout.

A prompt raised by a page that was then reloaded, navigated away or closed
stayed queued ahead of every later request. The content script now holds a port
for the life of its document, and when it closes the background rejects that
document's pending approvals, closes their popup windows and surfaces the next
request. The approval screen also answers the request it is displaying rather
than the id the panel last sent, so a decision can never land on a request that
replaced the one on screen.

Opening another extension's side panel covers Moth's panel without closing it,
so the panel kept its port and the background took a prompt sent there as shown
on screen; the dApp waited until the user opened Moth by hand. Panels now report
their visibility over that port, and a prompt opens the panel or a popup unless
a Moth panel is actually visible.
