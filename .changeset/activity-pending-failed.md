---
'@shieldedtech/moth-wallet': patch
'@shieldedtech/moth-browser': patch
'@shieldedtech/moth-extension': patch
---

Show a submitted transaction in the activity feed as pending, then as failed
when it does not go through.

The feed only re-read itself when sync applied a batch, so on a fast chain a
send's pending row was replaced by the finalized one before the panel ever
fetched it, and a transaction that never landed stayed pending for a day and
then vanished. The offscreen host now tells the panel when a submission is
recorded or ruled failed, and the panel re-reads the feed on that signal.

Three sources rule a submission failed: the node rejecting it at submission
(the rejection is kept with the record), the wallet SDK's pending-transaction
tracker reporting a failed or expired transaction (`startWalletSync` exposes
this through the new `onTransactionOutcome` option), and, once the wallet is
synced, two hours passing with no sign of it on chain. A chain entry that
arrives later still wins. DUST registration and deregistration report a
rejection the same way, and deregistration now announces its proving stage
before, not after, the proof is made.
