import { describe, expect, it } from 'vitest';
import { syncStatusView } from '../lib/ui/sync-view';
import { makeBalances } from './balances-fixture';

describe.each(['shielded', 'unshielded', 'dust'] as const)('%s sync progress', (role) => {
  it.each([
    { applied: 759, total: 1000, expected: 75 },
    { applied: 995, total: 1000, expected: 99 },
    { applied: 1000, total: 1000, expected: 99 },
    { applied: 1001, total: 1000, expected: 99 },
    { applied: 0, total: 0, expected: 0 },
  ])('shows $expected% while incomplete at $applied/$total', ({ applied, total, expected }) => {
    const balances = makeBalances();
    balances.syncProgress[`${role}Synced`] = false;
    balances.subProgress[role] = { applied, total };

    expect(syncStatusView(balances)[role]).toBe(expected);
  });

  it('shows 100% when completion is confirmed even without relevant events', () => {
    const balances = makeBalances();
    balances.subProgress[role] = { applied: 0, total: 0 };

    expect(syncStatusView(balances)[role]).toBe(100);
  });
});
