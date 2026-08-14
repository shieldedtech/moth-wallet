import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NETWORKS,
  SUPPORTED_NETWORKS,
  resolveProverConfig,
} from '@shieldedtech/moth-wallet/types/network';
import { t } from '../lib/i18n';
import {
  NETWORK_DESCRIPTIONS,
  NETWORK_LABELS,
  NetworkFields,
  selectableNetworks,
  type NetworkConfigState,
} from '../components/screens/NetworkConfig';

// The two prover radios (WASM / proof server) sit in a second radiogroup
// alongside one radio per offered network, so the total tracks whatever
// selectableNetworks() returns. Deriving it means adding a network can't leave
// this assertion stale — a hardcoded count silently disagreed with the picker
// for twelve days after `local` was added.
const PROVER_RADIOS = 2;

/** React escapes text children, so a label or description compared against the
 * rendered markup has to be escaped the same way first — otherwise the first
 * description containing an apostrophe fails against a perfectly correct
 * render, and the failure reads as a missing entry. */
const escaped = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

const networkState = (over: Partial<NetworkConfigState> = {}): NetworkConfigState => ({
  network: 'preview',
  current: 'devnet',
  urls: {
    nodeUrl: DEFAULT_NETWORKS.preview!.nodeUrl,
    indexerUrl: DEFAULT_NETWORKS.preview!.indexerUrl,
    prover: resolveProverConfig(DEFAULT_NETWORKS.preview!),
  },
  currentUrls: {
    nodeUrl: DEFAULT_NETWORKS.devnet!.nodeUrl,
    indexerUrl: DEFAULT_NETWORKS.devnet!.indexerUrl,
    prover: resolveProverConfig(DEFAULT_NETWORKS.devnet!),
  },
  ready: true,
  changed: true,
  networkChanged: true,
  indexerChanged: true,
  requiresResyncConfirmation: true,
  usesOverrides: false,
  valid: true,
  developerMode: false,
  // Derived, not hardcoded: a literal list silently goes stale when a network
  // is added, as it did when `local` arrived.
  available: selectableNetworks(false, 'preprod'),
  needsValueWarning: false,
  pick: vi.fn(),
  edit: vi.fn(() => vi.fn()),
  editAuthHeader: vi.fn(() => vi.fn()),
  setProverType: vi.fn(),
  editProverUrl: vi.fn(),
  resetEndpoints: vi.fn(),
  save: vi.fn(),
  ...over,
});

describe('NetworkFields', () => {
  it('renders the supported networks as an accessible single-choice list', () => {
    const state = networkState();
    const html = renderToStaticMarkup(<NetworkFields state={state} />);

    expect(html).toContain('role="radiogroup"');
    // One radio per offered network plus the two proving options. Derived from
    // `available` rather than SUPPORTED_NETWORKS minus a literal: which networks
    // are gated is a property of VALUE_BEARING, and hardcoding "one of them"
    // here would fail a correct picker the moment a second one is added.
    expect(html.match(/role="radio"/g)).toHaveLength(state.available.length + PROVER_RADIOS);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Preview');
    expect(html).toContain('Local');
    expect(html).not.toContain('Custom');
    expect(html).toContain('Node URL');
    expect(html).toContain('Indexer URL');
    expect(html).toContain('Proof server URL');
    expect(html).toContain('WASM');
    expect(html).toContain('recommended for simple transactions');
    expect(html).toContain('Complex transactions, such as contract calls, require a proof server');
  });

  // A network added to SUPPORTED_NETWORKS without a NETWORK_LABELS entry still
  // renders a radio, just a blank one — the count assertion above cannot see
  // that. `local` shipped unlabelled for exactly this reason. The Record type on
  // both maps makes a missing entry a compile error; this asserts the entries
  // are non-empty and actually reach the markup a user reads.
  it('names and describes every supported network', () => {
    // Developer mode on so the gated mainnet is offered too: every network in
    // SUPPORTED_NETWORKS has to be nameable, including the ones hidden by
    // default.
    const html = renderToStaticMarkup(
      <NetworkFields
        state={networkState({ developerMode: true, available: selectableNetworks(true, 'preprod') })}
      />,
    );

    for (const network of SUPPORTED_NETWORKS) {
      const label = NETWORK_LABELS[network];
      const description = t(NETWORK_DESCRIPTIONS[network]);

      expect(label, `${network} has no label`).not.toBe('');
      expect(description, `${network} has no description`).not.toBe('');
      expect(html, `${network} label is not rendered`).toContain(`>${escaped(label)}</span>`);
      expect(html, `${network} description is not rendered`).toContain(escaped(description));
    }
  });
});

// This wallet is unaudited and unsupported, so a network carrying real value must
// not be reachable by accident. These pin the gate itself rather than a count.
describe('value-bearing networks', () => {
  const base = (over: Partial<NetworkConfigState>): NetworkConfigState =>
    ({
      network: 'preprod',
      current: 'preprod',
      urls: {
        nodeUrl: DEFAULT_NETWORKS.preprod!.nodeUrl,
        indexerUrl: DEFAULT_NETWORKS.preprod!.indexerUrl,
        prover: resolveProverConfig(DEFAULT_NETWORKS.preprod!),
      },
      currentUrls: {
        nodeUrl: DEFAULT_NETWORKS.preprod!.nodeUrl,
        indexerUrl: DEFAULT_NETWORKS.preprod!.indexerUrl,
        prover: resolveProverConfig(DEFAULT_NETWORKS.preprod!),
      },
      ready: true, changed: false, networkChanged: false, indexerChanged: false,
      requiresResyncConfirmation: false, usesOverrides: false, valid: true,
      developerMode: false, available: selectableNetworks(false, 'preprod'),
      needsValueWarning: false,
      pick: vi.fn(), edit: vi.fn(() => vi.fn()), editAuthHeader: vi.fn(() => vi.fn()),
      setProverType: vi.fn(), editProverUrl: vi.fn(), resetEndpoints: vi.fn(), save: vi.fn(),
      ...over,
    }) as NetworkConfigState;

  it('hides mainnet by default', () => {
    expect(selectableNetworks(false, 'preprod')).not.toContain('mainnet');
  });

  it('offers mainnet once developer mode is on', () => {
    expect(selectableNetworks(true, 'preprod')).toContain('mainnet');
  });

  it('never strands a wallet already on a gated network', () => {
    // Hiding the network an account lives on would leave it unreachable with no
    // way back, so the current network is always offered.
    expect(selectableNetworks(false, 'mainnet')).toContain('mainnet');
  });

  it('explains the omission rather than silently shortening the list', () => {
    const html = renderToStaticMarkup(<NetworkFields state={base({})} />);
    expect(html).not.toContain('Mainnet');
    expect(html).toContain('unaudited and unsupported');
  });

  it('drops the notice when nothing is being withheld', () => {
    const html = renderToStaticMarkup(
      <NetworkFields state={base({ developerMode: true, available: selectableNetworks(true, 'preprod') })} />,
    );
    expect(html).toContain('Mainnet');
    expect(html).not.toContain('unaudited and unsupported');
  });
});
