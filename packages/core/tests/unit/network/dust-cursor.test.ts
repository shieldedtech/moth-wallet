import {beforeEach, describe, expect, it, vi} from 'vitest';

const getBlockCursors = vi.fn();
vi.mock('../../../src/network/indexer-client.js', () => ({
  IndexerClient: class {
    getBlockCursors(height: number) { return getBlockCursors(height); }
  },
}));

const {dustCursorAtHeight, DUST_CURSOR_MARGIN} = await import('../../../src/network/dust-cursor.js');

beforeEach(() => getBlockCursors.mockReset());

describe('dustCursorAtHeight', () => {
  // Measured against references whose cursors are known. The sum overshoots the
  // real cursor by a few hundred to a couple of thousand events, and the error is
  // NOT constant — so it is only usable with a margin subtracted.
  it.each([
    // height,   commit,   gen,     real stored cursor
    [2_064_324, 1_047_893, 369_292, 1_415_589],
    [2_104_384, 1_059_933, 372_037, 1_431_375],
  ])('stops below the real cursor at height %s', async (height, commit, gen, realCursor) => {
    getBlockCursors.mockResolvedValue({height, dustCommitmentEndIndex: commit, dustGenerationEndIndex: gen});
    const e = await dustCursorAtHeight('http://unused', height);
    expect(e).not.toBeNull();
    // Stopping BELOW the real cursor is the whole safety property: the reference
    // then holds less than the height it claims. Claiming more than you hold is
    // what loses funds.
    expect(e!.stopAt).toBeLessThan(realCursor);
    expect(e!.approxCursor).toBe(commit + gen);
    expect(e!.margin).toBe(DUST_CURSOR_MARGIN);
  });

  it('accepts the counters as numeric strings', async () => {
    getBlockCursors.mockResolvedValue({dustCommitmentEndIndex: '1000000', dustGenerationEndIndex: '300000'});
    const e = await dustCursorAtHeight('http://unused', 2_000_000);
    expect(e?.approxCursor).toBe(1_300_000);
  });

  it.each([
    ['an unreadable block', null],
    ['a block with no dust counters', {height: 1}],
    ['a commitment index that is not a number', {dustCommitmentEndIndex: 'x', dustGenerationEndIndex: 1}],
  ])('returns null for %s rather than guessing', async (_l, block) => {
    getBlockCursors.mockResolvedValue(block);
    await expect(dustCursorAtHeight('http://unused', 1_000)).resolves.toBeNull();
  });

  // Too early to be sure about: the margin swallows the whole estimate, and
  // genesis is already the answer there.
  it('refuses a target whose estimate is inside the margin', async () => {
    getBlockCursors.mockResolvedValue({dustCommitmentEndIndex: 100, dustGenerationEndIndex: 50});
    await expect(dustCursorAtHeight('http://unused', 500)).resolves.toBeNull();
  });

  it.each([0, -5, 1.5])('refuses a non-height (%s) without asking the indexer', async (h) => {
    await expect(dustCursorAtHeight('http://unused', h)).resolves.toBeNull();
    expect(getBlockCursors).not.toHaveBeenCalled();
  });
});
