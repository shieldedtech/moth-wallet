---
"@shieldedtech/moth-extension": patch
---

Say when a proof worker never responded. A proof job that timed out without its worker ever asking for a key was reported as "it was proving", which hid a worker that had dropped the job or died. The timeout now says "the proof worker never responded to it" in that case, keeps "it was proving" for a job that had fetched its keys, and still names any key it was waiting on.
