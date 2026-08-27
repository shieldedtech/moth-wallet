// Row bounding for the Wallet State view.
//
// Ink renders a frame in full and has no viewport. A frame taller than the
// terminal corrupts its redraw and lines overwrite one another — the failure
// components/Select.tsx already describes ("makes Ink collapse the two lines
// onto one"). The Wallet State view had no such bound: every coin got a row.
//
// Observed on mainnet, where a shielded wallet holds a large number of coins:
// the itemised list ran past the section and painted over the ones below it,
// producing lines like
//
//   Ba29ed4a053c1ec576e7f7684832c062bebc5cf67c0a4a9242f4defebd4b112b94  522  (1 coin)
//
// — the Unshielded section's `Balance` label with a token row on top of it. Note
// the label itself cannot produce that string: Label pads with padEnd and never
// truncates, which is what identifies this as terminal overwrite rather than a
// formatting bug.

import { describe, expect, it } from 'vitest';
import { flattenBalanceRows, shouldItemise, type DisplayTokenGroup } from '../../src/utils/balance.js';
import { balanceBudget, truncateMiddle, windowRows } from '../../src/utils/display.js';

const TOKEN = `token-${'x'.repeat(50)}-suffix`;

const group = (token: string, coins: number): DisplayTokenGroup => ({
  token,
  total: BigInt(coins),
  coins: Array.from({ length: coins }, () => ({ value: 1n, type: token, registered: false, booked: false })),
});

/** Lines a bounded block actually prints: the items plus the "and N more" line. */
function renderedRows(groups: DisplayTokenGroup[], maxRows: number): number {
  const rows = flattenBalanceRows(groups);
  const budget = rows.length > maxRows ? maxRows - 1 : maxRows;
  const { shown, hidden } = windowRows(rows, budget);
  return shown.length + (hidden > 0 ? 1 : 0);
}

describe('truncateMiddle', () => {
  it('leaves a value that already fits', () => {
    expect(truncateMiddle('NIGHT', 20)).toBe('NIGHT');
  });

  it('elides the middle and keeps both ends recognisable', () => {
    const short = truncateMiddle(TOKEN, 24);
    expect(short).toHaveLength(24);
    expect(short.startsWith('token-xxxxxx')).toBe(true);
    expect(short.endsWith('xxxx-suffix')).toBe(true);
  });

  it('never exceeds the width it was given', () => {
    for (const max of [1, 2, 5, 12, 41, 64, 100]) {
      expect(truncateMiddle(TOKEN, max).length).toBeLessThanOrEqual(Math.max(max, 0));
    }
  });
});

describe('windowRows', () => {
  it('bounds the list and reports the remainder', () => {
    const { shown, hidden } = windowRows(Array.from({ length: 500 }, (_, i) => i), 6);
    expect(shown).toHaveLength(6);
    expect(hidden).toBe(494);
  });

  it('hides everything when there is no room', () => {
    expect(windowRows([1, 2, 3], 0)).toEqual({ shown: [], hidden: 3 });
  });

  it('honours a per-item cost, so a two-line item counts twice', () => {
    // A deregistered dust coin renders a second line for its dtime.
    const items = [{ tall: true }, { tall: true }, { tall: false }];
    const { shown, hidden } = windowRows(items, 3, (i) => (i.tall ? 2 : 1));
    expect(shown).toHaveLength(1);
    expect(hidden).toBe(2);
  });
});

describe('flattenBalanceRows', () => {
  it('emits a header only for a single unflagged coin', () => {
    const rows = flattenBalanceRows([group(TOKEN, 1)]);
    expect(shouldItemise(group(TOKEN, 1))).toBe(false);
    expect(rows).toEqual([{ kind: 'group', group: 0 }]);
  });

  it('emits a header plus one row per coin once itemised', () => {
    const rows = flattenBalanceRows([group(TOKEN, 3)]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ kind: 'group', group: 0 });
    expect(rows.filter((r) => r.kind === 'coin')).toHaveLength(3);
  });

  it('counts many tokens as well as many coins', () => {
    // Capping only the inner coin list would leave this unbounded: the volume
    // here is in the number of tokens, one header each.
    const groups = Array.from({ length: 200 }, (_, i) => group(`${i}`.padStart(64, '0'), 1));
    expect(flattenBalanceRows(groups)).toHaveLength(200);
  });
});

describe('a section never renders taller than its budget', () => {
  it('bounds a wallet holding a huge number of coins in one token', () => {
    // The mainnet case that broke the view.
    const { maxRows } = balanceBudget(40, 120);
    expect(renderedRows([group(TOKEN, 4000)], maxRows)).toBeLessThanOrEqual(maxRows);
  });

  it('bounds a wallet holding a huge number of tokens', () => {
    const { maxRows } = balanceBudget(40, 120);
    const groups = Array.from({ length: 900 }, (_, i) => group(`${i}`.padStart(64, '0'), 2));
    expect(renderedRows(groups, maxRows)).toBeLessThanOrEqual(maxRows);
  });

  it('leaves a short wallet untouched', () => {
    const { maxRows } = balanceBudget(40, 120);
    expect(renderedRows([group(TOKEN, 2)], maxRows)).toBe(3); // header + 2 coins, no "more" line
  });
});

describe('balanceBudget', () => {
  it('keeps the three sections inside a normal terminal', () => {
    const rows = 40;
    const { maxRows } = balanceBudget(rows, 120);
    expect(maxRows * 3).toBeLessThanOrEqual(rows);
  });

  it('still shows something on a terminal too short to fit the chrome', () => {
    expect(balanceBudget(10, 80).maxRows).toBe(2);
  });

  it('keeps a token header off a second line at 80 columns', () => {
    const { tokenWidth } = balanceBudget(40, 80);
    // indent(4) + token + gap(2) + a wide amount + "  (1000 coins)"
    const worstCase = 4 + tokenWidth + 2 + '1234567890.123456'.length + '  (1000 coins)'.length;
    expect(worstCase).toBeLessThanOrEqual(80);
  });

  it('never pads a token id beyond its real length', () => {
    expect(balanceBudget(40, 400).tokenWidth).toBeLessThanOrEqual(64);
  });
});
