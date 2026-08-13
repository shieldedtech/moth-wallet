import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NETWORKS, SUPPORTED_NETWORKS, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';
import {
  NetworkFields,
  selectableNetworks,
  type NetworkConfigState,
} from '../components/screens/NetworkConfig';

describe('NetworkFields', () => {
  it('renders the supported networks as an accessible single-choice list', () => {
    const state: NetworkConfigState = {
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
      pick: vi.fn(),
      developerMode: false,
      // Derived, not hardcoded: a literal list silently goes stale when a
      // network is added, as it did when `local` arrived.
      available: selectableNetworks(false, 'preprod'),
      needsValueWarning: false,
      editAuthHeader: vi.fn(() => vi.fn()),
      edit: vi.fn(() => vi.fn()),
      setProverType: vi.fn(),
      editProverUrl: vi.fn(),
      resetEndpoints: vi.fn(),
      save: vi.fn(),
    };

    const html = renderToStaticMarkup(<NetworkFields state={state} />);

    expect(html).toContain('role="radiogroup"');
    // Every network except the gated mainnet, plus the two proving options.
    // Mainnet's absence is asserted by name below, not by this count.
    expect(html.match(/role="radio"/g)).toHaveLength(SUPPORTED_NETWORKS.length - 1 + 2);
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
