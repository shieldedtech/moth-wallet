---
"@shieldedtech/moth-extension": minor
---

Count requests to the node and indexer, with outcomes, on the debug page.

Written for a specific problem: one person sees HTTP 403 from the node and
nobody else does. 403 there means rate limiting, so the useful evidence is
request volume — but nothing measured it, and "it feels like a lot" is not
something you can take to whoever runs the endpoint.

`debug.html` now shows, per host over a rolling five minutes: total requests,
the rate now, the mean over the last minute, the **busiest single second and
when it occurred**, and what came back.

The peak is the number that matters most. A mean of 0.8/s reads as harmless
while a burst of forty in one second is what actually gets refused — and by the
time anyone opens this page the burst is over, so it has to be retained rather
than sampled. It is measured as a sliding second, not a fixed bucket, so a burst
that straddles a boundary is not split in half and understated. 403 is
called out by name rather than folded into a 4xx bucket, because it is the
answer this exists to give, and a network-level failure is counted separately
from an HTTP error — they are different problems.

The figures outlive both things that used to erase them. Rates are windowed
because a rate over all time means nothing, but totals, outcomes and the peak
are kept for as long as the browser has been open. Two separate mechanisms were
throwing them away: the rolling window pruned a host out of existence once its
last request aged past five minutes, and the meter itself lives in the offscreen
document, which every lock closes — so a wallet that got two 403s and then
auto-locked showed an empty page. Both cases hid exactly the evidence someone
opened the page to read. The peak is now computed as each request arrives rather
than swept from a list that pruning may since have emptied, and the background
retains each meter's figures across the gap when a new one replaces it. Folding
is a sum for counts and a **max** for the peak — two bursts of 30 are a peak of
30, not 60. Each row carries how long that host has been quiet, so a retained
403 from an hour ago cannot read as one happening now.

The retained figures live in `storage.session`: memory-only, never written to
disk, which matters because the captured failures carry request bodies. Nothing
drops them implicitly — which is why **Clear** now zeroes the counters as well
as the timings, since otherwise there would be no way to start from a known
baseline before reproducing a problem.

Two things worth knowing about the numbers. Requests are counted when **sent**,
not when they resolve, because that is what a rate limiter sees; a request still
in flight appears in the total with no outcome yet. And the meter wraps `fetch`
and `WebSocket` in the offscreen worker, installed before the host is
lazy-imported, so it catches the wallet SDK's own traffic — which is most of it.
Counting only our `IndexerClient` would have measured a small fraction and
looked reassuring.

Always on, with no toggle. A counter you have to remember to enable is one you
do not have when the problem happens. The cost is an array push per request
against a network round trip, and the window is pruned on every read so a long
session cannot grow it.

Counts alone answer "how much", but not "is it us". A 403 could be the wallet
sending something malformed or the endpoint refusing this caller, and telling
those apart means sending the same request from outside the extension. So the
last five failures are also kept verbatim — method, URL, headers, body, and
what came back — each with a **Copy as curl** button that replays it.

The curl emits `$MOTH_NODE_AUTH` where the node auth header belongs. That header
is injected by `declarativeNetRequest` after JavaScript hands the request off,
so it is genuinely not visible to the capture; a command that quietly omitted it
would fail for a different reason than the original and send someone chasing the
wrong thing.

One rejection is deliberately not captured. The relay probe GETs the JSON-RPC
endpoint once a minute in order to be refused — a healthy Midnight node answers
405, and any HTTP answer at all proves the endpoint is alive rather than down.
Recording that as a failure filled all five slots with the same expected 405
within five minutes and evicted the 403s the panel exists to preserve. It is
still counted in the table, because volume is volume; it just does not consume
the evidence buffer. A POST that gets 405 is a genuine surprise and is still
captured.

Capture is deliberately conservative. A request body is only read when it is
already a string — a stream is left alone and reported as absent, because
consuming it would break the very request being diagnosed. The response is read
from a clone, so the wallet still gets its own body. Header values matching
`auth|token|cookie|secret|key|bypass` are replaced with `[redacted]`, bodies are
truncated, and only the newest five are held.

This splits the page in two, and the UI says so. The counts remain hosts and
numbers only, and **Copy JSON** exports just those — still safe to paste into an
issue unread. The failures panel carries real request contents, is marked as
such, and is copied one at a time on purpose: nothing puts it on the clipboard
without a deliberate click.
