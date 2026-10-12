import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WalletInfo } from '@shieldedtech/moth-browser';
import { Accounts, RevealedSecretView } from '../components/screens/Accounts';
import { hasNoRecoveryPhrase } from '../lib/ui/backup';

const preprodAccount = {
  name: 'Sable',
  address: 'mn_addr_preprod1exampleaddress',
  network: 'preprod',
  active: true,
  addresses: {},
} as WalletInfo;

function render(wallets: WalletInfo[]): string {
  return renderToStaticMarkup(
    <Accounts
      wallets={wallets}
      activeName="Sable"
      onBack={() => {}}
      onChanged={async () => {}}
      onRenamed={async () => {}}
      onSwitched={async () => {}}
      onNewAccount={() => {}}
    />,
  );
}

describe('Accounts', () => {
  it('shows each account’s network beside its name', () => {
    const html = render([preprodAccount]);

    expect(html).toContain('Sable');
    expect(html).toContain('Preprod');
    expect(html).toContain('aria-label="Network: Preprod"');
  });

  it('shows the user-set label instead of the storage name', () => {
    const html = render([{ ...preprodAccount, label: 'Savings' } as WalletInfo]);

    expect(html).toContain('Savings');
    expect(html).not.toContain('>Sable<');
  });
});

describe('RevealedSecretView', () => {
  it('renders mnemonic words as numbered chips with the spend warning', () => {
    const html = renderToStaticMarkup(
      <RevealedSecretView secret={{ kind: 'mnemonic', value: 'alpha beta gamma' }} />,
    );

    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toContain('gamma');
    expect(html).toContain('Anyone with these words can spend your tokens');
    expect(html).toContain('Copy to clipboard');
    expect(html).not.toContain('raw hex seed');
  });

  it('renders a hex seed with the no-phrase note instead of word chips', () => {
    const html = renderToStaticMarkup(
      <RevealedSecretView secret={{ kind: 'seed', value: 'abcd1234'.repeat(8) }} />,
    );

    expect(html).toContain('abcd1234'.repeat(8));
    expect(html).toContain('imported from a raw hex seed');
    expect(html).toContain('Anyone with these words can spend your tokens');
  });
});

// The reveal dialog's body renders through a Radix portal, which
// renderToStaticMarkup does not reach, so the decision it turns on is asserted
// here instead. Reveal used to offer "recovery phrase" for every account and
// then hand back the seed for accounts that have none, which read as the tab
// selection being ignored.
describe('hasNoRecoveryPhrase', () => {
  it('is true for a seed-restored account, which has no phrase to reveal', () => {
    expect(hasNoRecoveryPhrase({ backupKind: 'seed' })).toBe(true);
  });

  it('is false for a phrase-backed account', () => {
    expect(hasNoRecoveryPhrase({ backupKind: 'mnemonic' })).toBe(false);
  });

  it('is false when unknown, so an existing phrase is never greyed out', () => {
    // Accounts written before backupKind existed. Treating unknown as seed-only
    // would hide a phrase that does exist; unlock backfills the field anyway.
    expect(hasNoRecoveryPhrase({})).toBe(false);
  });
});
