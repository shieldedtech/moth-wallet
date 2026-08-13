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
});
