/**
 * Turning a date into a block height, so a user importing a wallet can say
 * "this seed had no activity before <date>" instead of scanning from genesis.
 *
 * It must land on the last block STRICTLY BEFORE the target. The failure modes
 * are asymmetric: too early costs a slower sync, too late hides funds — so the
 * search errs early by construction.
 */

import {describe, expect, it} from 'vitest';
import {findHeightBefore} from '../../../src/network/block-time.js';

/** A synthetic chain: block N at epoch N * 10s. */
const chain = (tip: number) => async (height: number) =>
  height < 1 || height > tip ? null : {height, timestamp: height * 10_000};

describe('findHeightBefore', () => {
  it('finds the last block before an instant', async () => {
    const got = await findHeightBefore(chain(1000), 1000, 500_000);
    expect(got.height).toBe(49);
    expect(got.timestamp).toBeLessThan(500_000);
  });

  it('never returns a block at or after the target', async () => {
    for (const target of [123_456, 700_000, 999_999]) {
      const got = await findHeightBefore(chain(1000), 1000, target);
      expect(got.timestamp).toBeLessThan(target);
    }
  });

  it('clamps to the first block when the target predates the chain', async () => {
    const got = await findHeightBefore(chain(1000), 1000, 1);
    expect(got.height).toBe(1);
  });

  it('returns the tip when the target is in the future', async () => {
    const got = await findHeightBefore(chain(1000), 1000, 99_999_999);
    expect(got.height).toBe(1000);
  });

  it('is logarithmic — a 2M-block chain costs a couple of dozen lookups', async () => {
    let calls = 0;
    const counted = async (h: number) => {
      calls += 1;
      return chain(2_000_000)(h);
    };
    await findHeightBefore(counted, 2_000_000, 10_000_000_000);
    expect(calls).toBeLessThan(30);
  });

  it('tolerates gaps where a height returns nothing', async () => {
    const gappy = async (h: number) => (h % 7 === 0 ? null : chain(1000)(h));
    const got = await findHeightBefore(gappy, 1000, 500_000);
    expect(got.timestamp).toBeLessThan(500_000);
  });
});
