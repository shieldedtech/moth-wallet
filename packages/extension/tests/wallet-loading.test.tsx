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

  // The restore takes minutes on preprod. A user who opened the wrong network
  // must see which one is loading and be able to leave it without waiting.
  it('shows the loading network and a way into Settings', () => {
    const html = renderToStaticMarkup(
      <WalletLoading syncMessage="Restoring dust state from cache..." network="preprod" onSettings={() => {}} />,
    );

    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-label="Network: Preprod"');
  });

  it('offers no Settings button when nothing can handle it', () => {
    const html = renderToStaticMarkup(<WalletLoading syncMessage="" />);

    expect(html).not.toContain('aria-label="Settings"');
  });
});
