// Parity between the TUI's Wallet State view and the extension panel.
//
// The core reports `balances.unshielded[token]` as the SDK's available balance
// plus every booked (pending) input — a send or DUST registration reserves its
// own NIGHT UTxOs while the transaction is in flight, and they settle back on
// apply. The TUI builds its rows from the coin lists instead, so it has to count
// the same booked coins or the two surfaces disagree: observed on preprod as
// NIGHT 5,423.9987 in the TUI against 8,423.998700 in the extension, a gap of
// exactly the 3 booked coins.

import { describe, expect, it } from 'vitest';
import { groupCoinsForDisplay } from '../../src/utils/balance.js';

const NIGHT = '0100000000000000000000000000000000000000000000000000000000000000';
const OTHER = '944b825b3b60dccc1012d730a73a438ca5dfcf7845608e9a01452f077be9eed6';

const coin = (value: bigint, type: string, registeredForDustGeneration = false) => ({
  value,
  type,
  registeredForDustGeneration,
});

describe('groupCoinsForDisplay', () => {
  it('counts booked coins toward the token total, matching the core balance', () => {
    // The observed preprod state: 6 available NIGHT coins summing to 5,423.9987
    // (what the TUI showed), and 3 × 1,000 NIGHT booked by an in-flight DUST
    // registration — the extension showed 8,423.998700. NIGHT is denominated in
    // STAR (10^6), so 1,000 NIGHT is 1_000_000_000n raw.
    const available = [
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
      coin(423_998_700n, NIGHT, true),
    ];
    const booked = [
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
      coin(1_000_000_000n, NIGHT, true),
    ];

    const availableOnly = available.reduce((sum, c) => sum + c.value, 0n);
    expect(availableOnly).toBe(5_423_998_700n); // what the TUI used to display

    const [group] = groupCoinsForDisplay(available, booked, 'unshielded');

    // What the core reports, and therefore what the extension shows.
    const coreBalance = [...available, ...booked].reduce((sum, c) => sum + c.value, 0n);
    expect(group.total).toBe(coreBalance);
    expect(group.total).toBe(8_423_998_700n);
    expect(group.coins).toHaveLength(9);
  });

  it('keeps a row for a token whose coins are all booked', () => {
    // Previously this token had no available coins, so it had no row at all and
    // read as "not held" while the extension still listed it.
    const groups = groupCoinsForDisplay([], [coin(4_627n, OTHER)], 'unshielded');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.token).toBe(OTHER);
    expect(groups[0]?.total).toBe(4_627n);
    expect(groups[0]?.coins[0]?.booked).toBe(true);
  });

  it('flags booked and dust-registered coins separately', () => {
    const groups = groupCoinsForDisplay(
      [coin(1_000n, NIGHT, true)],
      [coin(2_000n, NIGHT, false)],
      'unshielded',
    );

    expect(groups[0]?.coins.map((c) => ({ registered: c.registered, booked: c.booked }))).toEqual([
      { registered: true, booked: false },
      { registered: false, booked: true },
    ]);
  });

  it('never marks shielded coins as dust-registered', () => {
    // registeredForDustGeneration is meaningless for shielded coins; the flag
    // must not leak into that view even if the field is present.
    const groups = groupCoinsForDisplay([coin(50n, NIGHT, true)], [], 'shielded');

    expect(groups[0]?.coins[0]?.registered).toBe(false);
  });

  it('groups multiple tokens independently', () => {
    const groups = groupCoinsForDisplay(
      [coin(123_456n, OTHER), coin(1_111n, OTHER), coin(500n, NIGHT)],
      [],
      'unshielded',
    );

    expect(groups.map((g) => [g.token, g.total])).toEqual([
      [OTHER, 124_567n],
      [NIGHT, 500n],
    ]);
  });
});
