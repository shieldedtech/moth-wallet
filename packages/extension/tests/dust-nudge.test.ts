import { describe, expect, it } from 'vitest';
import { hasUnregisteredNightToNudge } from '../lib/ui/dust-nudge';
import { makeBalances } from './balances-fixture';

describe('hasUnregisteredNightToNudge', () => {
  it('is false with no balances yet', () => {
    expect(hasUnregisteredNightToNudge(null)).toBe(false);
  });

  it('is false while the dust sub-wallet is still syncing, even with unregistered NIGHT', () => {
    const balances = makeBalances({ night: 1_000_000n, dustSynced: false });
    expect(hasUnregisteredNightToNudge(balances)).toBe(false);
  });

  it('is false with no NIGHT held', () => {
    const balances = makeBalances({ night: 0n });
    expect(hasUnregisteredNightToNudge(balances)).toBe(false);
  });

  it('is true once NIGHT is held, unregistered, fully synced', () => {
    const balances = makeBalances({ night: 1_000_000n });
    expect(hasUnregisteredNightToNudge(balances)).toBe(true);
  });

  it('is false once the wallet has registered', () => {
    const balances = makeBalances({ night: 1_000_000n, registered: true });
    expect(hasUnregisteredNightToNudge(balances)).toBe(false);
  });
});
