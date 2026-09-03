/**
 * Shielded coins this process has spent, so they stop being offered as
 * available before the wallet's own sync notices.
 *
 * Why this exists: the SDK moves UNSHIELDED coins available→pending when a
 * transaction reserves them, so a spend is reflected immediately. Shielded
 * coins get no such treatment — `pendingCoins` on the shielded side also holds
 * INCOMING coins, so it cannot be used to infer an outgoing spend — and a spent
 * coin therefore keeps appearing in `availableCoins` until sync catches up.
 *
 * That is not cosmetic. Anything selecting a coin from that stale list builds a
 * transaction the balancer cannot satisfy, which surfaces as
 * `Insufficient funds for fallible segment N` — an error naming the wrong cause,
 * because the coin genuinely no longer exists. Observed end-to-end: unwrap a
 * shielded coin successfully, retry immediately, and the wallet offers the same
 * spent coin again.
 *
 * Keyed on nullifier because `AvailableCoin` already carries one and it
 * identifies a spend exactly.
 *
 * Deliberately in-memory and process-local: it is a short-lived correction to a
 * sync lag, not durable state. Losing it on restart is harmless — by then sync
 * has almost certainly caught up — and persisting nullifiers would put
 * spend-linking data on disk for no benefit.
 */

const spent = new Map<string, number>();

/** Entries older than this are dropped: sync will long since have caught up. */
const TTL_MS = 10 * 60 * 1000;

const key = (nullifier: string): string => nullifier.replace(/^0x/i, '').toLowerCase();

/** Record nullifiers belonging to coins a submitted transaction spends. */
export function markShieldedSpent(nullifiers: readonly string[]): void {
  const now = Date.now();
  for (const n of nullifiers) {
    if (typeof n === 'string' && n.length > 0) spent.set(key(n), now);
  }
}

/** True when a coin with this nullifier was spent by this process. */
export function isShieldedSpent(nullifier: string | undefined): boolean {
  if (!nullifier) return false;
  const at = spent.get(key(nullifier));
  if (at === undefined) return false;
  if (Date.now() - at > TTL_MS) {
    spent.delete(key(nullifier));
    return false;
  }
  return true;
}

/** Testing/diagnostics: how many spends are currently being suppressed. */
export function spentShieldedCount(): number {
  return spent.size;
}

/** Testing: drop all recorded spends. */
export function clearShieldedSpent(): void {
  spent.clear();
}

/**
 * Shielded input nullifiers of a transaction, best effort.
 *
 * Accessors are `guaranteedOffer` (a single offer) and `fallibleOffer` (a Map
 * keyed by segment) — not `guaranteedCoins`. Anything unexpected is skipped
 * rather than thrown: failing to record a spend degrades to the old stale
 * behaviour, whereas throwing would break submission itself.
 */
export function shieldedNullifiersOf(tx: unknown): string[] {
  const out: string[] = [];
  const t = tx as {
    guaranteedOffer?: { inputs?: Array<{ nullifier?: string }> };
    fallibleOffer?: Map<number, { inputs?: Array<{ nullifier?: string }> }>;
  };
  try {
    const offers = [
      ...(t?.guaranteedOffer ? [t.guaranteedOffer] : []),
      ...(t?.fallibleOffer ? Array.from(t.fallibleOffer.values()) : []),
    ];
    for (const offer of offers) {
      for (const input of offer?.inputs ?? []) {
        if (typeof input?.nullifier === 'string') out.push(input.nullifier);
      }
    }
  } catch {
    /* best effort — see doc comment */
  }
  return out;
}
