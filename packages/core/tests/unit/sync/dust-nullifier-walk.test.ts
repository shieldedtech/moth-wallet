// A projections pass follows a coin's spend chain one lookup per spend. These
// pin where each lookup starts: the first at block zero, every later one at the
// earliest block the one before it matched.

import { describe, expect, it } from 'vitest';
import { Chunk, Effect, Stream } from 'effect';
import { nullifierLeHex, resumingFromLastSpend } from '../../../src/sync/dust-nullifier-walk.js';

interface Match {
  readonly blockHeight: number;
}

/** A lookup that answers each call with the next scripted result and records where it was asked to start. */
const scripted = (answers: ReadonlyArray<ReadonlyArray<number>>) => {
  const startedFrom: number[] = [];
  let call = 0;
  const lookup = (_nullifiers: ReadonlyArray<bigint>, fromBlock: number) => {
    startedFrom.push(fromBlock);
    return Stream.fromIterable((answers[call++] ?? []).map((blockHeight): Match => ({ blockHeight })));
  };
  return { lookup, startedFrom };
};

const collect = (stream: Stream.Stream<Match>) =>
  Effect.runPromise(Stream.runCollect(stream)).then((chunk) => Chunk.toArray(chunk).map((m) => m.blockHeight));

describe('resumingFromLastSpend', () => {
  it('starts the first lookup of a pass at block zero', async () => {
    const { lookup, startedFrom } = scripted([[40]]);
    await collect(resumingFromLastSpend(lookup)([1n], 100, 2));
    expect(startedFrom).toEqual([0]);
  });

  it('starts each later lookup at the block the previous one matched', async () => {
    const { lookup, startedFrom } = scripted([[40], [55], [90], []]);
    const walk = resumingFromLastSpend(lookup);
    for (let hop = 0; hop < 4; hop++) await collect(walk([1n], 100, 2));
    expect(startedFrom).toEqual([0, 40, 55, 90]);
  });

  it('starts at the earliest match when several coins were spent, whatever order they arrive in', async () => {
    const { lookup, startedFrom } = scripted([[70, 30, 50], []]);
    const walk = resumingFromLastSpend(lookup);
    await collect(walk([1n, 2n, 3n], 100, 2));
    await collect(walk([4n, 5n, 6n], 100, 2));
    expect(startedFrom).toEqual([0, 30]);
  });

  it('passes every match through unchanged', async () => {
    const { lookup } = scripted([[70, 30, 50]]);
    expect(await collect(resumingFromLastSpend(lookup)([1n], 100, 2))).toEqual([70, 30, 50]);
  });

  it('gives each pass its own starting point', async () => {
    const { lookup, startedFrom } = scripted([[40], [60]]);
    await collect(resumingFromLastSpend(lookup)([1n], 100, 2));
    await collect(resumingFromLastSpend(lookup)([1n], 100, 2));
    expect(startedFrom).toEqual([0, 0]);
  });

  it('reads the starting point when the lookup runs, not when it is built', async () => {
    const { lookup, startedFrom } = scripted([[40], []]);
    const walk = resumingFromLastSpend(lookup);
    const first = walk([1n], 100, 2);
    const second = walk([2n], 100, 2);
    await collect(first);
    await collect(second);
    expect(startedFrom).toEqual([0, 40]);
  });
});

describe('nullifierLeHex', () => {
  it('encodes 32 bytes, least significant first', () => {
    expect(nullifierLeHex(0x0102n)).toBe('0201' + '00'.repeat(30));
    expect(nullifierLeHex((1n << 255n) + 0xabn)).toBe('ab' + '00'.repeat(30) + '80');
  });
});
