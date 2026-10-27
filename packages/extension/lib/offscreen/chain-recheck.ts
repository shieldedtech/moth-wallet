// The chain behind an indexer changes only across the indexer's restart, and nothing the SDK
// exposes says so, therefore every cached thing bound to a chain — the sync engine, an account's
// capsule runtime — is re-verified when it is handed out, not only when it was made. One window
// for all of them: ten seconds between two looks is soon enough for a chain that changes across a
// restart, and one bounded query per ten seconds of use is cheap enough.
export const CHAIN_RECHECK_MS = 10_000;

/** Something handed out that remembers when the chain behind it was last looked at. */
export interface ChainChecked {
  chainCheckedAt: number;
}

/**
 * Whether a look at the chain is due for `state`, taking the look if it is: the window closes
 * before the first caller's query answers, so however many callers arrive inside one window, one
 * asks and the rest trust the answer they will all see.
 */
export function takeChainRecheck(state: ChainChecked, now: number = Date.now()): boolean {
  if (now - state.chainCheckedAt < CHAIN_RECHECK_MS) return false;
  state.chainCheckedAt = now;
  return true;
}
