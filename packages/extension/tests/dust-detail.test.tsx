import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { DustDetail, looksLikeDustAddress } from '../components/screens/DustDetail';
import { makeBalances } from './balances-fixture';

const OWN_DUST_ADDRESS = `mn_dust_preprod1${'w'.repeat(50)}`;

function render(balances: WalletBalances): string {
  return renderToStaticMarkup(
    <DustDetail
      balances={balances}
      txStage={null}
      proverType="server"
      network="preprod"
      ownDustAddress={OWN_DUST_ADDRESS}
      onBack={() => {}}
    />,
  );
}

describe('looksLikeDustAddress', () => {
  it('accepts bech32m dust addresses and rejects other shapes', () => {
    expect(looksLikeDustAddress(OWN_DUST_ADDRESS)).toBe(true);
    expect(looksLikeDustAddress(`  ${OWN_DUST_ADDRESS}  `)).toBe(true);
    expect(looksLikeDustAddress(`mn_addr_preprod1${'a'.repeat(30)}`)).toBe(false);
    expect(looksLikeDustAddress('mn_dust_preprod1short')).toBe(false);
    expect(looksLikeDustAddress('')).toBe(false);
  });
});

describe('DustDetail', () => {
  it('overlays the screen and holds the register CTA while dust syncs', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 1_000_000n, dustSynced: false });
    const html = renderToStaticMarkup(
      <DustDetail
        balances={balances}
        txStage={null}
        proverType="server"
        network="preprod"
        ownDustAddress={OWN_DUST_ADDRESS}
        onBack={() => {}}
      />,
    );

    expect(html).toContain('Syncing DUST');
    expect(html).not.toContain('Syncing tDUST');
    expect(html).toContain('Final amounts show once sync completes.');
    expect(html).not.toContain('Fully generated');
    expect(html).not.toContain('Start generating');
  });

  it('shows final amounts and the register CTA once synced', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 1_000_000n, dustSynced: true });
    const html = render(balances);

    expect(html).not.toContain('Syncing DUST');
    expect(html).toContain('Fully generated');
    expect(html).toContain('Start generating tDUST');
  });

  // The fixed six-place core formatter made a whole holding read as
  // "120.000000" here while the activity feed trimmed it, so the same balance
  // read two different ways depending on the surface.
  it('names the backing NIGHT balance as a whole number', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 120n * 10n ** 6n });
    const html = render(balances);

    expect(html).toContain('From your 120 tNIGHT');
    expect(html).not.toContain('120.000000');
  });

  it('attributes the cap to the generating NIGHT, not the whole balance', () => {
    // Key registered (all UTXOs flagged) but generation records only back
    // 3,000 of 4,424 tNIGHT — the caption must reflect the generating amount
    // and the note must quantify the idle remainder. No register CTA: the key
    // is registered, so there is nothing the register op could add.
    const balances = makeBalances({
      dust: 5_000_000n,
      limit: 15_000n * 10n ** 15n,
      night: 4_424n * 10n ** 6n,
      registered: true,
      generatingNight: 3_000n * 10n ** 6n,
      dustSynced: true,
    });
    const html = render(balances);

    expect(html).toContain('From your 3,000 tNIGHT generating now');
    // renderToStaticMarkup escapes the apostrophe in "isn't".
    expect(html).toContain('1,424 tNIGHT isn&#x27;t generating tDUST yet');
    // The invariant is that no register-amount CTA renders at all (canRegister
    // is false — nothing is unregistered), so match any number formatting. A
    // literal needle carrying today's grouping would pass vacuously against a
    // regression to fixed decimals, which renders "Register 1424.000000".
    expect(html).not.toMatch(/Register [\d.,]+ tNIGHT/);
    expect(html).toContain('Registered — generating');
  });

  it('offers to register NIGHT that is not flag-registered', () => {
    const balances = makeBalances({
      dust: 5_000_000n,
      limit: 15_000n * 10n ** 15n,
      night: 4_424n * 10n ** 6n,
      registered: true,
      registeredNight: 3_000n * 10n ** 6n,
      generatingNight: 3_000n * 10n ** 6n,
      dustSynced: true,
    });
    const html = render(balances);

    expect(html).toContain('Register 1,424 tNIGHT');
    expect(html).toContain('registered for tDUST generation');
  });

  it('offers no register CTA when the whole balance is registered and generating', () => {
    const balances = makeBalances({
      dust: 5_000_000n,
      limit: 5_000n * 10n ** 15n,
      night: 1_000n * 10n ** 6n,
      registered: true,
      dustSynced: true,
    });
    const html = render(balances);

    expect(html).not.toContain('Register 0');
    expect(html).not.toContain('Start generating tDUST');
    expect(html).toContain('From your 1,000 tNIGHT generating now');
  });

  it('offers to stop generation while registered and synced', () => {
    const registered = makeBalances({
      dust: 5_000_000n,
      limit: 5_000n * 10n ** 15n,
      night: 1_000n * 10n ** 6n,
      registered: true,
      dustSynced: true,
    });
    expect(render(registered)).toContain('Stop generating tDUST');

    const syncing = makeBalances({ dust: 5_000_000n, limit: 5_000n * 10n ** 15n, night: 1_000n * 10n ** 6n, registered: true, dustSynced: false });
    expect(render(syncing)).not.toContain('Stop generating tDUST');

    const unregistered = makeBalances({ dust: 0n, limit: 0n, night: 1_000n * 10n ** 6n, dustSynced: true });
    expect(render(unregistered)).not.toContain('Stop generating tDUST');
  });
});
