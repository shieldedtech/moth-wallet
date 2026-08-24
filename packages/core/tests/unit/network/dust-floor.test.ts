import {beforeEach, describe, expect, it, vi} from 'vitest';

const dustGenerationsFor = vi.fn();
const heightForDate = vi.fn();
vi.mock('../../../src/network/dust-generations.js', () => ({
  dustGenerationsFor: (...a: unknown[]) => dustGenerationsFor(...a),
}));
vi.mock('../../../src/network/block-time.js', () => ({
  heightForDate: (...a: unknown[]) => heightForDate(...a),
}));

const {firstDustGenerationHeight} = await import('../../../src/network/dust-floor.js');
import type {NetworkConfig} from '../../../src/types/network.js';

const network = {id: 'preprod', indexerUrl: 'http://unused'} as NetworkConfig;
const entry = (ctime: number) => ({ctime, generationMtIndex: 1, commitmentMtIndex: 1, value: '1', initialValue: '1'});

beforeEach(() => {
  dustGenerationsFor.mockReset();
  heightForDate.mockReset();
  heightForDate.mockResolvedValue({height: 1_697_238});
});

describe('firstDustGenerationHeight', () => {
  it('takes the EARLIEST entry, not the first one returned', async () => {
    // A register → deregister → re-register history returns several; the bound
    // is the first one, and the subscription does not promise an order.
    dustGenerationsFor.mockResolvedValue({
      entries: [entry(1_800_000_000), entry(1_784_294_394), entry(1_790_000_000)],
      dtimeUpdates: 0, truncated: false, highestIndex: 10,
    });
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor).toEqual({kind: 'height', height: 1_697_238, ctime: 1_784_294_394});
    expect(heightForDate.mock.calls[0][1]).toEqual(new Date(1_784_294_394 * 1000));
  });

  // "never generated" is a real answer and unlocks any reference — but only when
  // the query actually finished. Confusing it with "nothing came back" would
  // authorise seeding past real history, which is the failure this guards.
  it('reports never when the query completed and found nothing', async () => {
    dustGenerationsFor.mockResolvedValue({entries: [], dtimeUpdates: 0, truncated: false, highestIndex: 0});
    await expect(firstDustGenerationHeight(network, 'mn_dust_preprod1x')).resolves.toEqual({kind: 'never'});
  });

  it('reports unknown when the query was cut short', async () => {
    dustGenerationsFor.mockResolvedValue({entries: [], dtimeUpdates: 0, truncated: true, highestIndex: 0});
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor.kind).toBe('unknown');
  });

  // A decay update only exists for an address that IS generating, so it proves
  // "never" wrong without giving a height.
  it('reports unknown when only decay updates arrived', async () => {
    dustGenerationsFor.mockResolvedValue({entries: [], dtimeUpdates: 3, truncated: false, highestIndex: 5});
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor.kind).toBe('unknown');
    if (floor.kind === 'unknown') expect(floor.reason).toMatch(/decay/);
  });

  it('reports unknown when the query throws', async () => {
    dustGenerationsFor.mockRejectedValue(new Error('indexer down'));
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor.kind).toBe('unknown');
    if (floor.kind === 'unknown') expect(floor.reason).toMatch(/indexer down/);
  });

  it('reports unknown when the timestamp cannot be mapped to a height', async () => {
    dustGenerationsFor.mockResolvedValue({entries: [entry(1_784_294_394)], dtimeUpdates: 0, truncated: false, highestIndex: 1});
    heightForDate.mockRejectedValue(new Error('no readable blocks'));
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor.kind).toBe('unknown');
  });

  it.each([0, -1, Number.NaN])('reports unknown for an unusable ctime (%s)', async (ctime) => {
    dustGenerationsFor.mockResolvedValue({entries: [entry(ctime)], dtimeUpdates: 0, truncated: false, highestIndex: 1});
    const floor = await firstDustGenerationHeight(network, 'mn_dust_preprod1x');
    expect(floor.kind).toBe('unknown');
  });
});
