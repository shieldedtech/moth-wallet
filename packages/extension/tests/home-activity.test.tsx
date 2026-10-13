import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { ActivityEntry } from '@shieldedtech/moth-browser';
import { Home } from '../components/screens/Home';
import { makeBalances } from './balances-fixture';

// The feed the mocked hook returns; each test sets it before rendering.
const feed = vi.hoisted(() => ({ value: null as ActivityEntry[] | null }));

vi.mock('../lib/ui/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ui/client')>()),
  useActivity: () => feed.value,
}));

const sent: ActivityEntry = {
  hash: 'a'.repeat(64),
  kind: 'sent',
  status: 'SUCCESS',
  timestamp: new Date('2026-07-13T09:58:00'),
  deltas: [{ tokenType: NIGHT_TOKEN_ID, kind: 'unshielded', amount: -120_000_000n }],
  dustDelta: 0n,
  counterparty: 'mn_addr_preprod1qw986g7d2hx35u2c2vx',
  fees: null,
  pending: false,
};

function render() {
  return renderToStaticMarkup(
    <Home
      walletName="Sable"
      network="preprod"
      balances={makeBalances({ night: 1_000_000n })}
      syncMessage=""
      relayState={null}
      navigate={() => {}}
    />,
  );
}

// "See all" is the only way into the full feed, so the section must stay put
// whatever the feed holds — an empty or unread feed used to hide it entirely.
describe('Home recent activity', () => {
  it('keeps the heading and See all while the feed is still loading', () => {
    feed.value = null;
    const html = render();

    expect(html).toContain('Recent activity');
    expect(html).toContain('See all');
    expect(html).not.toContain('No activity yet');
  });

  it('keeps the heading and See all over an empty state when there is nothing yet', () => {
    feed.value = [];
    const html = render();

    expect(html).toContain('Recent activity');
    expect(html).toContain('See all');
    expect(html).toContain('No activity yet');
  });

  it('lists the newest rows in place of the empty state', () => {
    feed.value = [sent];
    const html = render();

    expect(html).toContain('See all');
    expect(html).toContain('Sent to mn_addr_…c2vx');
    expect(html).not.toContain('No activity yet');
  });
});
