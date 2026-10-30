import { browser } from 'wxt/browser';
// Import from core's pure network-config subpath, NOT the moth-browser barrel:
// the barrel drags in the ledger WASM (top-level await), which cannot exist in
// the service worker's module graph. See lib/offscreen for where WASM lives.
import {
  canonicalNetworkId,
  DEFAULT_NETWORKS,
  isProverConfig,
  proverConfigsEqual,
  resolveProverConfig,
  serverProver,
  type NetworkConfig,
} from '@shieldedtech/moth-wallet/types/network';
import type { ExtensionSettings, NetworkEndpoints, NodeAuthHeader } from '../messaging/protocol';

const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  // NOT mainnet. This wallet is unaudited, unsupported and for development, so a
  // fresh install must not land on a network carrying real value. Preprod is the
  // default because it is the network with a bundled pre-seed reference, so a new
  // account syncs in seconds rather than an hour. Existing installs keep whatever
  // they saved — only new ones see this.
  network: 'preprod',
  customEndpoints: null,
  endpointOverrides: {},
  // A real timeout by default; users opt into "Never (demo mode)" explicitly.
  autoLockMinutes: 60,
  // Send-to-name is opt-in: no resolver configured until the user sets one.
  nameResolverUrl: null,
  // Opt-in: warming costs a full chain walk in the background (~71 min on
  // preprod). Never start that without the user asking for it.
  preseedWarming: false,
  // Diagnostic detail is opt-in; the plain warning it augments is not.
  developerMode: false,
  // Cardano follows the Midnight network, always. It does nothing at all
  // until the user supplies a Blockfrost project id.
  blockfrostProjectId: null,
  blockfrostProjectIds: {},
  blockfrostUrl: null,
  cnightPolicyId: null,
  cnightAssetName: null,
};

/** Per-network Blockfrost ids, dropping anything that is not a usable string. */
function parseProjectIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [network, id] of Object.entries(value as Record<string, unknown>)) {
    const trimmed = parseOptionalText(id);
    if (trimmed && ['Mainnet', 'Preprod', 'Preview'].includes(network)) out[network] = trimmed;
  }
  return out;
}

/** Trim to a non-empty string, or null. Used for every optional Cardano field. */
function parseOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Accept a stored name-resolver base URL. Must be an http(s) URL; anything
 *  else (including empty) disables send-to-name. Trailing slash trimmed. */
function parseResolverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const url = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** Accept a stored node auth header. A blank name or value means "none" — the
 *  header is dropped entirely rather than sent empty, which some gateways treat
 *  differently from absent. Header names are restricted to the RFC 7230 token
 *  characters so a malformed one cannot smuggle a second header. */
export function parseNodeAuthHeader(value: unknown): NodeAuthHeader | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<NodeAuthHeader>;
  if (typeof candidate.name !== 'string' || typeof candidate.value !== 'string') return undefined;
  const name = candidate.name.trim();
  const headerValue = candidate.value.trim();
  if (name === '' || headerValue === '') return undefined;
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined;
  // No CR/LF in the value, for the same reason.
  if (/[\r\n]/.test(headerValue)) return undefined;
  return { name, value: headerValue };
}

function parseEndpoints(value: unknown): NetworkEndpoints | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NetworkEndpoints> & { proofServerUrl?: unknown };
  if (typeof candidate.nodeUrl !== 'string' || typeof candidate.indexerUrl !== 'string') return null;
  const nodeAuthHeader = parseNodeAuthHeader(candidate.nodeAuthHeader);
  if (isProverConfig(candidate.prover)) {
    return {
      nodeUrl: candidate.nodeUrl,
      indexerUrl: candidate.indexerUrl,
      prover: candidate.prover,
      ...(nodeAuthHeader ? { nodeAuthHeader } : {}),
    };
  }
  // Migrate settings written before prover modalities were introduced.
  if (typeof candidate.proofServerUrl === 'string') {
    return {
      nodeUrl: candidate.nodeUrl,
      indexerUrl: candidate.indexerUrl,
      prover: serverProver(candidate.proofServerUrl),
      ...(nodeAuthHeader ? { nodeAuthHeader } : {}),
    };
  }
  return null;
}

/**
 * Endpoint overrides by network, keyed by today's network ids. A key that names a
 * renamed network moves to the current id unless that id already has its own.
 *
 * Settings written before overrides were kept per network hold one
 * `customEndpoints` object for the network saved alongside it; it becomes that
 * network's entry.
 */
function parseEndpointOverrides(saved: Record<string, unknown> | undefined): Record<string, NetworkEndpoints> {
  const out: Record<string, NetworkEndpoints> = {};
  const stored = saved?.endpointOverrides;
  const entries = stored && typeof stored === 'object' ? Object.entries(stored as Record<string, unknown>) : [];
  for (const canonicalFirst of [true, false]) {
    for (const [id, value] of entries) {
      if ((canonicalNetworkId(id) === id) !== canonicalFirst) continue;
      const key = canonicalNetworkId(id);
      const endpoints = parseEndpoints(value);
      if (endpoints && !(key in out)) out[key] = endpoints;
    }
  }
  const legacy = parseEndpoints(saved?.customEndpoints);
  const legacyNetwork = canonicalNetworkId(
    typeof saved?.network === 'string' ? saved.network : DEFAULT_SETTINGS.network,
  );
  if (legacy && !(legacyNetwork in out)) out[legacyNetwork] = legacy;
  return out;
}

/** Accept a stored auto-lock value, tolerating legacy/absent settings.
 *  `null` is a valid, deliberate value (demo mode); `undefined` → default. */
function parseAutoLock(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_SETTINGS.autoLockMinutes;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  // Canonicalised on read: a selection saved under a network id that has since
  // been renamed would otherwise match no preset and fall through to the
  // localhost guess below.
  const network = canonicalNetworkId(saved?.network ?? DEFAULT_SETTINGS.network);
  const endpointOverrides = parseEndpointOverrides(saved as Record<string, unknown> | undefined);
  return {
    network,
    customEndpoints: endpointOverrides[network] ?? null,
    endpointOverrides,
    autoLockMinutes: 'autoLockMinutes' in (saved ?? {}) ? parseAutoLock(saved?.autoLockMinutes) : DEFAULT_SETTINGS.autoLockMinutes,
    nameResolverUrl: parseResolverUrl(saved?.nameResolverUrl),
    preseedWarming: saved?.preseedWarming === true,
    developerMode: saved?.developerMode === true,
    blockfrostProjectId: parseOptionalText(saved?.blockfrostProjectId),
    blockfrostProjectIds: parseProjectIds(saved?.blockfrostProjectIds),
    blockfrostUrl: parseOptionalText(saved?.blockfrostUrl),
    cnightPolicyId: parseOptionalText(saved?.cnightPolicyId),
    cnightAssetName:
      // Distinct from the others: the testnet cNIGHT token has an EMPTY asset
      // name, so '' is a meaningful override and only `undefined` means unset.
      typeof saved?.cnightAssetName === 'string' ? saved.cnightAssetName.trim() : null,
  };
}


export async function updateSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  // Only what a caller actually set is persisted. Writing the whole resolved
  // object baked today's defaults into storage, so no default could move again.
  const saved = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const { customEndpoints, endpointOverrides, ...rest } = patch;
  const next: Partial<ExtensionSettings> = { ...saved, ...rest };
  // Overrides are kept per network, so switching away and back finds them again.
  // `customEndpoints` sets (or with null, clears) the entry for the network this
  // patch leaves selected; `endpointOverrides` replaces them all. A legacy single
  // `customEndpoints` is moved into the map on any write, before a network change
  // could make it read as the new network's.
  if ('customEndpoints' in patch || endpointOverrides || saved?.customEndpoints !== undefined) {
    const overrides = { ...(endpointOverrides ?? current.endpointOverrides) };
    if ('customEndpoints' in patch) {
      const network = canonicalNetworkId(patch.network ?? current.network);
      if (customEndpoints) overrides[network] = customEndpoints;
      else delete overrides[network];
    }
    next.endpointOverrides = overrides;
    delete next.customEndpoints;
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return getSettings();
}

/**
 * Resolve endpoints for a network (the selected one by default): its saved
 * overrides, or its preset.
 */
export async function getNetworkConfig(networkId?: string): Promise<NetworkConfig> {
  const { network: settingsNetwork, endpointOverrides } = await getSettings();
  const network = networkId === undefined ? settingsNetwork : canonicalNetworkId(networkId);
  const customEndpoints = endpointOverrides[network];
  const base = DEFAULT_NETWORKS[network] ?? {
    id: network,
    nodeUrl: 'ws://localhost:9944',
    // The GraphQL path is part of the endpoint, not decoration: the indexer
    // client posts queries to it, and the bare origin is not a GraphQL endpoint.
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    prover: serverProver(),
  };
  if (!customEndpoints) return base;
  return {
    id: base.id,
    ...(customEndpoints.nodeAuthHeader ? { nodeAuthHeader: customEndpoints.nodeAuthHeader } : {}),
    nodeUrl: customEndpoints.nodeUrl,
    indexerUrl: customEndpoints.indexerUrl,
    prover: customEndpoints.prover,
  };
}

/** Store null when the edited fields still match the named preset. */
export function endpointOverridesFor(network: string, endpoints: NetworkEndpoints): NetworkEndpoints | null {
  const preset = DEFAULT_NETWORKS[network];
  const nodeAuthHeader = parseNodeAuthHeader(endpoints.nodeAuthHeader);
  const normalized = {
    nodeUrl: endpoints.nodeUrl.trim(),
    indexerUrl: endpoints.indexerUrl.trim(),
    prover: endpoints.prover.type === 'server'
      ? serverProver(endpoints.prover.url.trim())
      : endpoints.prover,
    ...(nodeAuthHeader ? { nodeAuthHeader } : {}),
  };
  // An auth header is itself an override. Without this clause a header set
  // against otherwise-default URLs collapses to null and is silently discarded
  // on save — which is the common case, since the endpoint needing the header
  // is the preset one.
  if (
    preset &&
    !nodeAuthHeader &&
    normalized.nodeUrl === preset.nodeUrl &&
    normalized.indexerUrl === preset.indexerUrl &&
    proverConfigsEqual(normalized.prover, resolveProverConfig(preset))
  ) {
    return null;
  }
  return normalized;
}
