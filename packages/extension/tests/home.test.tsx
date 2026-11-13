import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Home } from '../components/screens/Home';
import { makeBalances } from './balances-fixture';

describe('Home', () => {
  it('shows the active account network in the account control', () => {
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={null} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain('Sable');
    expect(html).toContain('Preprod');
    expect(html).toContain('aria-label="Network: Preprod"');
    const networkControl = html.match(/<[^>]+aria-label="Network: Preprod"[^>]*>/)?.[0];
    expect(networkControl?.startsWith('<span')).toBe(true);
    expect(html).toContain('tNIGHT');
  });

  it('shows a whole NIGHT balance without a padded fraction', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 120n * 10n ** 6n });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).not.toContain('120.000000');
    expect(html).toContain('120 <span');
  });

  it('keeps the fraction when the NIGHT balance has one', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 120_500_000n });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain('120.5 <span');
  });

  it('overlays the dust card while the dust sub-wallet syncs', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 1_000_000n, dustSynced: false });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain('Syncing DUST');
    expect(html).not.toContain('Syncing tDUST');
    expect(html).not.toContain('Fully generated');
  });

  it('lists other unshielded tokens beside NIGHT, ready for naming', () => {
    const id = 'd'.repeat(64);
    const balances = makeBalances({ night: 1_000_000n, unshielded: { [id]: 123_456n } });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain(`${id.slice(0, 8)}…`);
    expect(html).toContain('Unshielded token');
    expect(html).toContain(`aria-label="Name token ${id.slice(0, 8)}…"`);
    // Grouped: asset rows go through formatTokenBalance, which groups the
    // integer even at decimals 0. Ungrouped output belongs to editable fields.
    expect(html).toContain('123,456');
  });

  it('shows assets instead of the fresh-wallet state when only minted tokens are held', () => {
    const id = 'd'.repeat(64);
    const balances = makeBalances({ night: 0n, unshielded: { [id]: 5n } });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain(`${id.slice(0, 8)}…`);
    expect(html).not.toContain('Add your first');
  });

  it('renders shielded token rows as buttons that open the naming dialog', () => {
    const id = 'c'.repeat(64);
    const balances = makeBalances({ night: 1_000_000n, shielded: { [id]: 42n } });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).toContain(`${id.slice(0, 8)}…`);
    expect(html).toContain(`aria-label="Name token ${id.slice(0, 8)}…"`);
  });

  it('drops the dust card overlay once synced', () => {
    const balances = makeBalances({ dust: 5_000_000n, limit: 5_000_000n, night: 1_000_000n, dustSynced: true });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={balances} syncMessage="" relayState={null} navigate={() => {}} />,
    );

    expect(html).not.toContain('Syncing DUST');
    expect(html).toContain('Fully generated');
  });
});

// A wallet can hold DUST with no NIGHT and no tokens — DUST is earned by
// registering NIGHT, not received, so it outlives the NIGHT that generated it.
// Reported as #76: the panel showed the "add your first NIGHT" screen and no
// balance at all, while the total was demonstrably non-zero.
describe('Home with DUST but nothing else', () => {
  const dustOnly = makeBalances({ dust: 5_000_000_000_000_000n, limit: 10_000_000_000_000_000n, night: 0n });

  it('still shows the DUST meter', () => {
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={dustOnly} syncMessage="" relayState={null} navigate={() => {}} />,
    );
    expect(html).toContain('Pays your fees');
  });

  it('still offers the funding prompt, since there is no NIGHT', () => {
    // The meter appearing must not imply the wallet is funded — Send stays
    // disabled and the prompt stays, because there is nothing to send.
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={dustOnly} syncMessage="" relayState={null} navigate={() => {}} />,
    );
    expect(html).toContain('disabled');
  });

  it('still shows the meter when there is no DUST either', () => {
    // Superseded #101's behaviour: the card used to be hidden for an empty
    // wallet, which made the DUST mechanism look absent rather than idle. It
    // now always shows and says which state it is in.
    const empty = makeBalances({ dust: 0n, limit: 0n, night: 0n });
    const html = renderToStaticMarkup(
      <Home walletName="Sable" network="preprod" balances={empty} syncMessage="" relayState={null} navigate={() => {}} />,
    );
    expect(html).toContain('Pays your fees');
  });
});

// A transaction that runs with no screen of its own — a dApp's request after its
// approval closed, a send whose screen was left — surfaces on Home, with the
// stage, the clock, and (for local proving) the expectation that it takes minutes.
describe('Home background activity', () => {
  const base = { walletName: 'Sable', network: 'preprod', balances: null, syncMessage: '', relayState: null, navigate: () => {} };

  it('shows the running stage with elapsed time', () => {
    const html = renderToStaticMarkup(
      <Home {...base} txStage="proving" txStageSince={Date.now() - 125_000} proverType="wasm" />,
    );

    expect(html).toContain('Working on a transaction');
    expect(html).toContain('Generating the proof…');
    expect(html).toContain('2:05 elapsed');
    expect(html).toContain('Proving on this device — a few minutes is normal.');
  });

  it('keeps the generic hint when the proof comes from a server', () => {
    const html = renderToStaticMarkup(
      <Home {...base} txStage="submitting" txStageSince={Date.now()} proverType="server" />,
    );

    expect(html).toContain('Submitting to the network…');
    expect(html).toContain('It keeps going if you close this panel.');
    expect(html).not.toContain('Proving on this device');
  });

  it('shows nothing when no transaction is in flight', () => {
    const html = renderToStaticMarkup(<Home {...base} />);

    expect(html).not.toContain('Working on a transaction');
  });
});
