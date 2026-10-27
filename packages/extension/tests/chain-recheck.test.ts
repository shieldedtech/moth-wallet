// A cached thing bound to a chain is re-verified when handed out, at most once per window: the
// window is taken by the first caller before any query answers, so concurrent callers ask once.

import { describe, expect, it } from 'vitest';
import { CHAIN_RECHECK_MS, takeChainRecheck } from '../lib/offscreen/chain-recheck';

describe('takeChainRecheck', () => {
  it('is not due inside the window and due once it has passed', () => {
    const state = { chainCheckedAt: 1_000 };
    expect(takeChainRecheck(state, 1_000 + CHAIN_RECHECK_MS - 1)).toBe(false);
    expect(state.chainCheckedAt).toBe(1_000);
    expect(takeChainRecheck(state, 1_000 + CHAIN_RECHECK_MS)).toBe(true);
    expect(state.chainCheckedAt).toBe(1_000 + CHAIN_RECHECK_MS);
  });

  it('is taken by the first caller of a window, so the rest in it trust the answer', () => {
    const state = { chainCheckedAt: 0 };
    const now = 50_000;
    expect([1, 2, 3].map(() => takeChainRecheck(state, now))).toEqual([true, false, false]);
    expect(takeChainRecheck(state, now + CHAIN_RECHECK_MS)).toBe(true);
  });
});
