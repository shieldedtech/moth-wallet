import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Unlock } from '../components/screens/Unlock';

describe('Unlock', () => {
  it('names the account on a cold unlock, and offers no Cancel', () => {
    // Deliberately no longer a generic "Welcome back": that was only
    // unambiguous with one account, and after deleting the active account the
    // panel promotes another silently — leaving a correct password rejected by
    // a different account with nothing on screen to explain it.
    const html = renderToStaticMarkup(<Unlock walletName="Account-1" onUnlock={async () => {}} />);
    expect(html).toContain('Unlock Account-1');
    expect(html).not.toContain('Welcome back');
    expect(html).not.toContain('>Cancel<');
  });

  it('prefers the account label over its storage name', () => {
    const html = renderToStaticMarkup(
      <Unlock
        walletName="Account-1"
        accounts={[{ name: 'Account-1', label: 'Savings', network: 'preprod' }]}
        onUnlock={async () => {}}
      />,
    );
    expect(html).toContain('Unlock Savings');
  });

  it('shows a picker only when there is a choice to make', () => {
    const one = renderToStaticMarkup(
      <Unlock
        walletName="Account-1"
        accounts={[{ name: 'Account-1', network: 'preprod' }]}
        onUnlock={async () => {}}
      />,
    );
    expect(one).not.toContain('role="radiogroup"');

    const two = renderToStaticMarkup(
      <Unlock
        walletName="Account-1"
        accounts={[
          { name: 'Account-1', network: 'preprod' },
          { name: 'Account-2', network: 'devnet' },
        ]}
        onUnlock={async () => {}}
      />,
    );
    expect(two).toContain('role="radiogroup"');
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
