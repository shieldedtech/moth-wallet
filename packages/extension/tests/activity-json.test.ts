import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '@shieldedtech/moth-browser';
import { deserializeActivity, serializeActivity } from '../lib/messaging/activity-json';

describe('activity serialization', () => {
  it('round-trips bigints, dates and nulls', () => {
    const entries: ActivityEntry[] = [
      {
        hash: 'a'.repeat(64),
        kind: 'sent',
        status: 'SUCCESS',
        timestamp: new Date('2026-07-13T09:58:00Z'),
        deltas: [{ tokenType: '0'.repeat(64), kind: 'unshielded', amount: -120_000_000n }],
        dustDelta: -400n,
        counterparty: 'mn_addr1c2vx',
        fees: 400n,
        pending: true,
      },
      {
        hash: 'b'.repeat(64),
        kind: 'dust',
        status: 'FAILURE',
        timestamp: null,
        deltas: [],
        dustDelta: 0n,
        counterparty: null,
        fees: null,
        pending: false,
      },
    ];

    const revived = deserializeActivity(serializeActivity(entries));

    expect(revived).toEqual(entries);
    expect(revived[0]?.timestamp).toBeInstanceOf(Date);
    expect(typeof revived[0]?.deltas[0]?.amount).toBe('bigint');
    expect(revived[1]?.timestamp).toBeNull();
  });
});
