import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WalletLoading } from '../components/screens/WalletLoading';

describe('WalletLoading', () => {
  it('turns internal DUST restore progress into a full-panel friendly state', () => {
    const html = renderToStaticMarkup(<WalletLoading syncMessage="Restoring dust state from cache..." />);

    expect(html).toContain('role="status"');
    expect(html).toContain('Getting things ready');
    expect(html).toContain('Preparing your wallet');
    expect(html).not.toContain('Restoring dust state from cache');
  });

  it('shows only the spinner while a sync is merely in progress', () => {
    const html = renderToStaticMarkup(
      <WalletLoading syncMessage="Syncing with network..." onOpenNetwork={() => {}} />,
    );
    expect(html).not.toContain('Change network');
    expect(html).not.toContain('unreachable');
  });

  // A hung sync (wrong network selected, an unreachable endpoint, or a
  // subsystem whose progress reads 100% but never flips `isSynced`) never
  // throws, so it can't reach the `failure` branch below — without an escape
  // hatch here the panel's router shows only WalletLoading forever, with no
  // error and no way to reach Settings -> Network.
  it('offers a way to Settings -> Network once the sync has been slow, even without a failure', () => {
    const html = renderToStaticMarkup(
      <WalletLoading syncMessage="Syncing with network..." slow onOpenNetwork={() => {}} />,
    );
    expect(html).toContain('unreachable');
    expect(html).toContain('Change network');
  });

  it('omits the button when the caller has nowhere to send it, but still explains the delay', () => {
    const html = renderToStaticMarkup(<WalletLoading syncMessage="Syncing with network..." slow />);
    expect(html).toContain('unreachable');
    expect(html).not.toContain('Change network');
  });

  it('prefers the hard failure over the slow-sync hint when both are true', () => {
    const html = renderToStaticMarkup(
      <WalletLoading
        syncMessage="Sync failed: Could not reach the indexer"
        slow
        onOpenNetwork={() => {}}
      />,
    );
    expect(html).toContain('Could not open your wallet');
    expect(html).toContain('Could not reach the indexer');
    // Only one "Change network" action, not the failure's and the slow
    // branch's stacked together.
    expect(html.match(/Change network/g)?.length ?? 0).toBe(1);
  });
});
