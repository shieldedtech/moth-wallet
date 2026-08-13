import { describe, expect, it } from 'vitest';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { ActivityEntry } from '@shieldedtech/moth-browser';
import {
  activityRowView,
  filterActivity,
  groupActivity,
} from '../lib/ui/activity-view';
import { TESTNET_NATIVE_ASSET_LABELS as labels } from '../lib/ui/token-labels';

const NOW = new Date('2026-07-13T12:00:00');
const OTHER = 'mn_addr_preprod1qw986g7d2hx35u2c2vx';

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    hash: Math.random().toString(36).slice(2).padEnd(64, '0'),
    kind: 'received',
    status: 'SUCCESS',
    timestamp: new Date('2026-07-13T09:12:00'),
    deltas: [],
    dustDelta: 0n,
    counterparty: null,
    fees: null,
    pending: false,
    ...overrides,
  };
}

const night = (amount: bigint) => ({ tokenType: NIGHT_TOKEN_ID, kind: 'unshielded' as const, amount });

describe('filterActivity', () => {
  const sent = entry({ kind: 'sent' });
  const received = entry({ kind: 'received' });
  const swap = entry({ kind: 'swap' });
  const dust = entry({ kind: 'dust' });
  const all = [sent, received, swap, dust];

  it('keeps everything under All', () => {
    expect(filterActivity(all, 'all')).toEqual(all);
  });

  it('shows swaps under both Sent and Received', () => {
    expect(filterActivity(all, 'sent')).toEqual([sent, swap]);
    expect(filterActivity(all, 'received')).toEqual([received, swap]);
  });

  it('keeps DUST rows only under the DUST filter', () => {
    expect(filterActivity(all, 'dust')).toEqual([dust]);
  });
});

describe('groupActivity', () => {
  it('groups by day distance, then month, keeping order', () => {
    const entries = [
      entry({ timestamp: new Date('2026-07-13T09:58:00') }),
      entry({ timestamp: new Date('2026-07-12T18:34:00') }),
      entry({ timestamp: new Date('2026-07-08T10:00:00') }),
      entry({ timestamp: new Date('2026-07-01T10:00:00') }),
      entry({ timestamp: new Date('2026-06-20T10:00:00') }),
      entry({ timestamp: new Date('2025-12-24T10:00:00') }),
      entry({ timestamp: null }),
    ];

    expect(groupActivity(entries, NOW).map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'June',
      'December 2025',
      'Earlier',
    ]);
  });
});

describe('activityRowView', () => {
  it('renders a confirmed send with recipient, negative amount and time', () => {
    const view = activityRowView(
      entry({
        kind: 'sent',
        counterparty: OTHER,
        deltas: [night(-45_000_000n)],
        timestamp: new Date('2026-07-12T18:34:00'),
      }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Sent to mn_addr_…c2vx');
    expect(view.sub).toBe('18:34');
    expect(view.amount).toBe('-45 tNIGHT');
    expect(view.tone).toBe('negative');
    expect(view.icon).toBe('sent');
  });

  it('renders a pending send as Sending with a muted amount', () => {
    const view = activityRowView(
      entry({
        kind: 'sent',
        pending: true,
        counterparty: OTHER,
        deltas: [night(-120_000_000n)],
        timestamp: new Date('2026-07-13T09:58:00'),
      }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Sending to mn_addr_…c2vx');
    expect(view.sub).toBe('09:58 · Pending');
    expect(view.amount).toBe('-120 tNIGHT');
    expect(view.tone).toBe('muted');
    expect(view.icon).toBe('pending');
  });

  it('renders a same-token batch as N transfers with the aggregate amount', () => {
    // 3 outputs of one token → deltas aggregate to a single negative delta.
    const view = activityRowView(
      entry({ kind: 'sent', counterparty: OTHER, outputs: 3, deltas: [night(-150_000_000n)] }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Sent 3 transfers');
    expect(view.amount).toBe('-150 tNIGHT');
  });

  it('renders a mixed-token batch as N transfers with no single amount', () => {
    const view = activityRowView(
      entry({
        kind: 'sent',
        counterparty: OTHER,
        outputs: 2,
        deltas: [night(-10_000_000n), { tokenType: 'a'.repeat(64), kind: 'shielded', amount: -50n }],
      }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Sent 2 transfers');
    expect(view.amount).toBeNull();
  });

  it('counts a shielded-only batch from its token deltas when outputs are unknown', () => {
    // Shielded recipients can't be seen (outputs 0); distinct token deltas drive the count.
    const view = activityRowView(
      entry({
        kind: 'sent',
        outputs: 0,
        deltas: [
          { tokenType: 'a'.repeat(64), kind: 'shielded', amount: -50n },
          { tokenType: 'b'.repeat(64), kind: 'shielded', amount: -20n },
        ],
      }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Sent 2 transfers');
  });

  it('renders a receive without a known sender by token name', () => {
    const view = activityRowView(
      entry({ kind: 'received', deltas: [night(120_000_000n)] }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Received tNIGHT');
    expect(view.amount).toBe('+120 tNIGHT');
    expect(view.tone).toBe('positive');
  });

  it('renders a swap naming both sides and showing the incoming amount', () => {
    const view = activityRowView(
      entry({
        kind: 'swap',
        deltas: [
          { tokenType: 'musd0000aaaa', kind: 'shielded', amount: 224_800_000n },
          night(-45_000_000n),
        ],
      }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Swapped tNIGHT for musd0000…');
    // Grouped, matching how the same token reads in its Home asset row.
    expect(view.amount).toBe('+224,800,000 musd0000…');
    expect(view.tone).toBe('positive');
    expect(view.icon).toBe('swap');
  });

  it('renders a registration entry as DUST with no amount when nothing measurable moved', () => {
    const view = activityRowView(entry({ kind: 'dust' }), labels, NOW);

    expect(view.title).toBe('tDUST registration');
    expect(view.amount).toBeNull();
    expect(view.icon).toBe('dust');
  });

  it('renders a dust-negative entry as a network fee', () => {
    const view = activityRowView(
      entry({ kind: 'dust', dustDelta: -400_000_000_000_000n }),
      labels,
      NOW,
    );

    expect(view.title).toBe('Network fee paid');
    expect(view.amount).toBe('-0.4 tDUST');
    expect(view.tone).toBe('negative');
  });

  it('marks failures in the subtitle and mutes the amount', () => {
    const view = activityRowView(
      entry({
        kind: 'sent',
        status: 'FAILURE',
        deltas: [night(-45_000_000n)],
        timestamp: new Date('2026-07-13T09:58:00'),
      }),
      labels,
      NOW,
    );

    expect(view.sub).toBe('09:58 · Failed');
    expect(view.tone).toBe('muted');
    expect(view.icon).toBe('failed');
  });

  it('uses the weekday for rows earlier this week and the date beyond', () => {
    const monday = activityRowView(
      entry({ timestamp: new Date('2026-07-08T10:00:00'), deltas: [night(500_000_000n)] }),
      labels,
      NOW,
    );
    expect(monday.sub).toBe('Wednesday');

    const older = activityRowView(
      entry({ timestamp: new Date('2026-06-20T10:00:00'), deltas: [night(500_000_000n)] }),
      labels,
      NOW,
    );
    expect(older.sub).toBe('20 Jun');
  });
});
