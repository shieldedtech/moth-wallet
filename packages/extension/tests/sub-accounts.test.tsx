import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SubAccounts } from '../components/moth/sub-accounts';

describe('the sub-account selector', () => {
  it('shows every sub-account by its label with the current one pressed, and a way to add one', () => {
    const html = renderToStaticMarkup(
      <SubAccounts
        accounts={{
          accounts: [
            { number: 0, label: 'Personal' },
            { number: 1, label: 'Work' },
          ],
          current: 1,
        }}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Personal');
    expect(html).toContain('aria-pressed="true"');
    expect(html.indexOf('aria-pressed="true"')).toBeGreaterThan(html.indexOf('Personal'));
    expect(html).toContain('+ New');
    expect(html).toContain('Rename');
    // The number is the derivation's; the screen keeps it to a tooltip.
    expect(html).toContain('title="Account 1"');
  });
});
