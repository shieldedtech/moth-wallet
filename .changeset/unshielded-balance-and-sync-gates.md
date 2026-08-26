---
"@shieldedtech/moth-wallet": patch
"@shieldedtech/moth-browser": patch
"@shieldedtech/moth-cli": patch
"@shieldedtech/moth-extension": patch
---

Stop a wallet with no shielded history from hanging, and stop it double-counting a stale booking.

Both faults surface together on a wallet that holds only unshielded NIGHT and has never held a shielded coin, which is why they went unnoticed on wallets with shielded history.

**Waiting for a sync that was already finished.** `WalletBalances.synced` comes from the SDK's `isStrictlyComplete()`, which is false forever for an EMPTY stream — and a wallet that never held a shielded coin has no shielded events at all. Every gate that blocked on `synced` therefore waited out its whole timeout while holding correct numbers: five minutes in `moth balance` and `moth transfer`, a rejection in the extension, and — with no timeout at all — the daemon simply never finished starting. Meanwhile the progress line said 100%, because the display already treated an empty stream as complete. `balancesSettled` is now the single definition both use: an empty stream is finished, with a guard so start-up, when every stream is briefly empty, is not mistaken for it.

**Counting a booked coin twice.** Booked inputs are folded into the displayed balance so it does not flash to zero while a transaction is in flight. That assumed the SDK's available and pending lists are disjoint, which they are until a booking is never released — then a resync re-adds the coin to the available list and it sits in both. The balance doubled, permanently, and the coin could not be spent. Such a coin is now counted once, and named in a sync message instead of being silently absorbed.

**Bookings moth abandoned.** Inputs are booked when a transaction is balanced, not when it is submitted, and the SDK only releases them via the submit path. A failure in between — proving against a proof server on a mismatched ledger version — leaked the booking. The transfer, DUST registration and deregistration paths now release it, as fee estimation already did.

**Progress that contradicted itself.** `{applied: 0, total: 0}` was read as "complete" by every consumer, and it means two different things: an empty stream with nothing to apply, or a part that restored a large cache and has not reported yet. Observed on preprod, with the TUI closed and nothing competing for the cache: `moth balance` printed `syncing 99% (shielded) — shielded 100%, unshielded 100%, dust 100%` three times over 80 seconds without moving, while `dust.dat`'s own cursor sat at 1,378,733 of 1,454,764 — 76,031 events behind. Two faults in one line: dust reported `{0, 0}` and read as finished, and with all three fractions then equal to 1 the "never round up" clamp pinned the total at 99% while the tie-break blamed `shielded`, naming a constraint that did not exist and could not advance.

Restored history is what separates the two cases: a part with a cached cursor cannot be an empty stream. Each part now carries `complete` / `behind` / `unreported`, resolved once where the cache is known and stamped onto the snapshot, so the display and the gates read one verdict rather than each re-deriving it. A part that has not reported renders as `—`, is named as the constraint, and blocks completion; a genuinely empty stream still counts as finished; and a true 100% is no longer clamped to 99%, while a near-complete fraction still is.

That last part also corrects the empty-stream fix above, which would have accepted an unreported part as empty — resolving the wait early and reporting a balance missing everything that part had yet to apply.

**A way out.** `moth wallet resync` discards a wallet's cached sync state (`--dust-only` keeps the larger caches). The eviction already existed but had no way in from the CLI, so the only remedy for a wedged wallet was deleting `~/.moth/sync/<network>/<wallet>/` by hand.

The underlying booking-lifecycle defects are upstream in the wallet SDK and reported in `docs/upstream/wallet-sdk-unshielded-booking-never-released.md`.
