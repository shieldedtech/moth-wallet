import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Unlock } from '../components/screens/Unlock';

describe('Unlock', () => {
  it('offers no Cancel on a cold/forced unlock', () => {
    const html = renderToStaticMarkup(<Unlock walletName="Account-1" onUnlock={async () => {}} />);
    expect(html).toContain('Welcome back');
    expect(html).not.toContain('>Cancel<');
  });

  it('offers Cancel and names the target when switching accounts', () => {
    const html = renderToStaticMarkup(
      <Unlock walletName="Account-2" accountName="Savings" onUnlock={async () => {}} onCancel={() => {}} />,
    );
    expect(html).toContain('Unlock Savings');
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('Welcome back');
  });
});
