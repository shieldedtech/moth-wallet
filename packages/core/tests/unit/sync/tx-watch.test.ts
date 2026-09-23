import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {watchInclusion, type InclusionOutcome} from '../../../src/sync/tx-watch.js';

const HASH = '00d47ac2efea5203dbd1fb8516f9bfb1996523d67572cad0b80d1b5878310b329d';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let the poll timer fire and its async tick settle. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('watchInclusion', () => {
  it('resolves included as soon as the indexer shows the transaction, without reverting', async () => {
    const seen = vi.fn<(h: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const revert = vi.fn(async () => {});
    const outcomes: InclusionOutcome[] = [];
    const watch = watchInclusion({hash: HASH, isIncluded: seen, revert, pollMs: 1_000, timeoutMs: 10_000, onOutcome: (o) => outcomes.push(o)});

    await advance(1_000);
    expect(seen).toHaveBeenCalledWith(HASH);
    await advance(1_000);

    const outcome = await watch.done;
    expect(outcome.kind).toBe('included');
    expect(revert).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
  });

  it('reverts once the window passes with the transaction still unseen', async () => {
    const revert = vi.fn(async () => {});
    const watch = watchInclusion({hash: HASH, isIncluded: async () => false, revert, pollMs: 1_000, timeoutMs: 3_000});

    await advance(2_999);
    expect(revert).not.toHaveBeenCalled();
    await advance(1);

    const outcome = await watch.done;
    expect(outcome.kind).toBe('reverted');
    expect(outcome.afterMs).toBeGreaterThanOrEqual(3_000);
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('reports a revert that fails, so the coin staying hidden is not silent', async () => {
    const watch = watchInclusion({
      hash: HASH,
      isIncluded: async () => false,
      revert: async () => {
        throw new Error('facade stopped');
      },
      pollMs: 500,
      timeoutMs: 500,
    });
    await advance(500);
    const outcome = await watch.done;
    expect(outcome).toMatchObject({kind: 'revert-failed', error: 'facade stopped'});
  });

  it('treats a failing indexer probe as "not yet", not as included', async () => {
    const isIncluded = vi
      .fn<(h: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(true);
    const revert = vi.fn(async () => {});
    const watch = watchInclusion({hash: HASH, isIncluded, revert, pollMs: 1_000, timeoutMs: 10_000});
    await advance(2_000);
    expect((await watch.done).kind).toBe('included');
    expect(revert).not.toHaveBeenCalled();
  });

  it('cancel stops polling and never reverts', async () => {
    const isIncluded = vi.fn(async () => false);
    const revert = vi.fn(async () => {});
    const watch = watchInclusion({hash: HASH, isIncluded, revert, pollMs: 1_000, timeoutMs: 2_000});
    watch.cancel();
    await advance(5_000);
    expect((await watch.done).kind).toBe('cancelled');
    expect(isIncluded).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it('a throwing outcome observer does not disturb the result', async () => {
    const watch = watchInclusion({
      hash: HASH,
      isIncluded: async () => true,
      revert: async () => {},
      pollMs: 100,
      onOutcome: () => {
        throw new Error('observer bug');
      },
    });
    await advance(100);
    expect((await watch.done).kind).toBe('included');
  });
});
