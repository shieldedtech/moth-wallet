// Recovery-phrase reveal, the part worth asserting (#166).
//
// The TUI has no Ink render harness, so the screen itself is not under test —
// what is, is the decision the screen paints: how many words, numbered from
// where, and whether the wallet has a phrase at all. The last one matters most:
// a hex-imported wallet has no mnemonic, and telling its owner that 128 hex
// characters are their "recovery phrase" sends them to write down something
// they will later try to restore as words.

import { describe, expect, it } from 'vitest';
import { buildRevealView, WORDS_PER_ROW } from '../../src/screens/reveal-view.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');

describe('buildRevealView — mnemonic', () => {
  it('numbers words from 1 in reading order', () => {
    const view = buildRevealView({ kind: 'mnemonic', value: words(24) });
    const flat = view.rows.flat();

    expect(flat).toHaveLength(24);
    expect(flat[0]).toEqual({ index: 1, word: 'word1' });
    expect(flat[23]).toEqual({ index: 24, word: 'word24' });
    expect(flat.map(w => w.index)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it('lays 24 words out six to a row', () => {
    const view = buildRevealView({ kind: 'mnemonic', value: words(24) });

    expect(view.rows).toHaveLength(4);
    expect(view.rows.every(r => r.length === WORDS_PER_ROW)).toBe(true);
  });

  it('keeps every word when the count is not a multiple of the row width', () => {
    // The onboarding display hardcodes 4 rows of 6 and would silently drop the
    // rest. A backup screen that shows 12 of 15 words is worse than none.
    const view = buildRevealView({ kind: 'mnemonic', value: words(15) });

    expect(view.rows.flat().map(w => w.word)).toEqual(
      Array.from({ length: 15 }, (_, i) => `word${i + 1}`),
    );
    expect(view.rows.at(-1)).toHaveLength(3);
  });

  it('does not produce empty slots from stray whitespace', () => {
    const view = buildRevealView({ kind: 'mnemonic', value: '  alpha \n beta\t\tgamma  ' });

    expect(view.rows.flat()).toEqual([
      { index: 1, word: 'alpha' },
      { index: 2, word: 'beta' },
      { index: 3, word: 'gamma' },
    ]);
  });

  it('offers no seed and no note when a phrase exists', () => {
    const view = buildRevealView({ kind: 'mnemonic', value: words(24) });

    expect(view.kind).toBe('mnemonic');
    expect(view.seedHex).toBeNull();
    expect(view.note).toBeNull();
  });
});

describe('buildRevealView — hex-imported wallet', () => {
  const SEED = 'a'.repeat(128);

  it('presents the seed as a seed, not as a phrase', () => {
    const view = buildRevealView({ kind: 'seed', value: SEED });

    expect(view.kind).toBe('seed');
    expect(view.seedHex).toBe(SEED);
    expect(view.rows).toEqual([]);
  });

  it('says why there is no phrase', () => {
    const view = buildRevealView({ kind: 'seed', value: SEED });

    expect(view.note).toMatch(/no recovery phrase/i);
  });
});
