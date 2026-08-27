import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_NETWORKS, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';
import { getSettings } from '../lib/background/settings';
import { onMessage, sendMessage } from '../lib/messaging/protocol';
import {
  loadedNetwork,
  NETWORK_LABELS,
  NetworkFields,
  selectableNetworks,
  type NetworkConfigState,
} from '../components/screens/NetworkConfig';

// What a profile saved by a build that offered `local` looks like on disk. The
// panel reads it back through the background, so the whole path is exercised:
// stored bytes → getSettings → messaging → the panel's load decision → markup.
const LEGACY_PROFILE = { network: 'local' as const };

/** The exact wiring from handlers.ts — the panel's only source of settings.
 *  Registered once: the messaging layer allows a single listener per message
 *  type per JS context, just as the real background does. */
const serveSettings = () => onMessage('settingsGet', () => getSettings());

/** The side panel constructs the screen with no fallback argument, so mainnet is
 *  what an unrecognised stored id resolves to. */
const PANEL_FALLBACK = 'mainnet' as const;

/** Reproduces the panel's load effect over real settings, then renders the
 *  picker exactly as the screen does. */
async function openNetworkPanel() {
  const settings = await sendMessage('settingsGet', undefined);
  const network = loadedNetwork(settings.network, PANEL_FALLBACK);
  const urls = settings.customEndpoints ?? {
    nodeUrl: DEFAULT_NETWORKS[network]!.nodeUrl,
    indexerUrl: DEFAULT_NETWORKS[network]!.indexerUrl,
    prover: resolveProverConfig(DEFAULT_NETWORKS[network]!),
  };
  const state: NetworkConfigState = {
    network,
    current: network,
    urls,
    currentUrls: urls,
    ready: true,
    changed: false,
    networkChanged: false,
    indexerChanged: false,
    requiresResyncConfirmation: false,
    usesOverrides: settings.customEndpoints !== null,
    valid: true,
    developerMode: settings.developerMode,
    available: selectableNetworks(settings.developerMode, network),
    needsValueWarning: false,
    pick: vi.fn(),
    edit: vi.fn(() => vi.fn()),
    editAuthHeader: vi.fn(() => vi.fn()),
    setProverType: vi.fn(),
    editProverUrl: vi.fn(),
    resetEndpoints: vi.fn(),
    save: vi.fn(),
  };
  return { settings, state, html: renderToStaticMarkup(<NetworkFields state={state} />) };
}

/**
 * The label on the one network radio the picker shows as selected.
 *
 * Scoped to radios carrying a network label: the screen renders a second
 * radiogroup for the proving method, and that one has a selected radio too.
 */
function checkedNetwork(html: string): string {
  const labelled = html
    .split('role="radio"')
    .slice(1)
    .map((radio) => ({
      checked: radio.startsWith(' aria-checked="true"'),
      label: Object.values(NETWORK_LABELS).find((name) => radio.includes(`>${name}</span>`)),
    }))
    .filter((radio): radio is { checked: boolean; label: string } => radio.label !== undefined);

  const selected = labelled.filter((radio) => radio.checked);
  expect(selected.map((radio) => radio.label), 'exactly one network is selected').toHaveLength(1);
  return selected[0]!.label;
}

describe('upgrading a profile saved on the retired local network', () => {
  beforeAll(() => serveSettings());
  beforeEach(() => fakeBrowser.storage.local.clear());

  it('opens the picker on Undeployed, selected', async () => {
    await fakeBrowser.storage.local.set({ settings: LEGACY_PROFILE });

    const { settings, state, html } = await openNetworkPanel();

    expect(settings.network).toBe('undeployed');
    expect(state.network).toBe('undeployed');
    expect(checkedNetwork(html)).toBe('Undeployed');
    expect(html).toContain(DEFAULT_NETWORKS.undeployed!.nodeUrl);
  });

  it('does not offer mainnet to a profile that never asked for it', async () => {
    // The failure this guards against is not a blank radio. `selectableNetworks`
    // never strands a wallet on the network it is already using, so a fallback to
    // mainnet would ALSO unhide mainnet with developer mode off — presenting a
    // value-bearing network as this account's own, one click from being saved.
    await fakeBrowser.storage.local.set({ settings: LEGACY_PROFILE });

    const { state, html } = await openNetworkPanel();

    expect(state.developerMode).toBe(false);
    expect(state.available).not.toContain('mainnet');
    expect(html).not.toContain('>Mainnet</span>');
  });

  it('keeps endpoint edits made while the network was called local', async () => {
    const customEndpoints = {
      nodeUrl: 'ws://localhost:19944',
      indexerUrl: 'http://localhost:18088/api/v4/graphql',
      prover: { type: 'wasm' as const },
    };
    await fakeBrowser.storage.local.set({ settings: { ...LEGACY_PROFILE, customEndpoints } });

    const { state, html } = await openNetworkPanel();

    expect(state.urls).toEqual(customEndpoints);
    expect(html).toContain('ws://localhost:19944');
  });

  // The mechanism above only works because the id is resolved before it reaches
  // the panel. An id with no mapping still takes the fallback, which is what
  // makes the migration load-bearing rather than decorative.
  it('still falls back for an id that has no current equivalent', async () => {
    await fakeBrowser.storage.local.set({ settings: { network: 'some-future-net' } });

    const { state } = await openNetworkPanel();

    expect(state.network).toBe(PANEL_FALLBACK);
  });
});
