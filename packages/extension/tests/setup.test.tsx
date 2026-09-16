import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PasswordStep } from '../entrypoints/setup/App';

const progress = { current: 3, total: 3 };

describe('setup PasswordStep', () => {
  it('offers an optional account-name field with the auto-assigned name as placeholder', () => {
    const html = renderToStaticMarkup(
      <PasswordStep
        progress={progress}
        busy={false}
        error=""
        name=""
        onNameChange={() => {}}
        defaultName="Account 3"
        recoveredBy="phrase"
        onBack={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain('Account name');
    expect(html).toContain('placeholder="Account 3"');
    expect(html).toContain('shown only in this wallet');
  });

  it('shows the typed name as the field value', () => {
    const html = renderToStaticMarkup(
      <PasswordStep
        progress={progress}
        busy={false}
        error=""
        name="Savings"
        onNameChange={() => {}}
        defaultName="Account 3"
        recoveredBy="phrase"
        onBack={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain('value="Savings"');
  });
});
