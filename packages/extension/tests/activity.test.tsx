import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Activity } from '../components/screens/Activity';
import { ActivityRow } from '../components/moth/activity';
import { activityRowView } from '../lib/ui/activity-view';
import { TESTNET_NATIVE_ASSET_LABELS as labels } from '../lib/ui/token-labels';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { makeBalances } from './balances-fixture';

const NOW = new Date('2026-07-13T12:00:00');

describe('Activity screen', () => {
  it('shows the header and the four filter chips with the network DUST label', () => {
    const html = renderToStaticMarkup(
      <Activity network="preprod" balances={makeBalances({})} onBack={() => {}} />,
    );

    expect(html).toContain('Activity');
    expect(html).toContain('>All<');
    expect(html).toContain('>Sent<');
    expect(html).toContain('>Received<');
    expect(html).toContain('>tDUST<');
  });

  it('does not flash the empty state while the feed is still loading', () => {
    const html = renderToStaticMarkup(
      <Activity network="preprod" balances={makeBalances({})} onBack={() => {}} />,
    );

    expect(html).not.toContain('Nothing here yet');
  });
});

describe('ActivityRow', () => {
  it('renders a pending send with spinner, muted amount and Pending subtitle', () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        view={activityRowView(
          {
            hash: 'a'.repeat(64),
            kind: 'sent',
            status: 'SUCCESS',
            timestamp: new Date('2026-07-13T09:58:00'),
            deltas: [{ tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: -120_000_000n }],
            dustDelta: 0n,
            counterparty: 'mn_addr_preprod1qw986g7d2hx35u2c2vx',
            fees: null,
            pending: true,
          },
          labels,
          NOW,
        )}
      />,
    );

    expect(html).toContain('Sending to mn_addr_…c2vx');
    expect(html).toContain('09:58 · Pending');
    expect(html).toContain('-120 tNIGHT');
    expect(html).toContain('animate-spin');
    expect(html).toContain('text-muted-foreground');
  });

  it('renders a received amount in the success tone', () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        view={activityRowView(
          {
            hash: 'b'.repeat(64),
            kind: 'received',
            status: 'SUCCESS',
            timestamp: new Date('2026-07-13T09:12:00'),
            deltas: [{ tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: 120_000_000n }],
            dustDelta: 0n,
            counterparty: 'mn_addr_preprod1qw986g7d2hx35u28kt4',
            fees: null,
            pending: false,
          },
          labels,
          NOW,
        )}
      />,
    );

    expect(html).toContain('Received from mn_addr_…8kt4');
    expect(html).toContain('+120 tNIGHT');
    expect(html).toContain('text-success');
  });

  // A minted token's holding must read the same in the feed as in its Home asset
  // row. These grouped differently for a while — the row said "123,456" and the
  // feed two cards below said "+123456" for the same balance.
  it('groups a non-NIGHT amount the way the asset rows do', () => {
    const id = 'd'.repeat(64);
    const html = renderToStaticMarkup(
      <ActivityRow
        view={activityRowView(
          {
            hash: 'c'.repeat(64),
            kind: 'received',
            status: 'SUCCESS',
            timestamp: new Date('2026-07-13T09:12:00'),
            deltas: [{ tokenType: id, kind: 'unshielded', amount: 123_456n }],
            dustDelta: 0n,
            counterparty: 'mn_addr_preprod1qw986g7d2hx35u28kt4',
            fees: null,
            pending: false,
          },
          labels,
          NOW,
        )}
      />,
    );

    expect(html).toContain('+123,456');
    expect(html).not.toContain('+123456');
  });
});
