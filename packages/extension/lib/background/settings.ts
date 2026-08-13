import { browser } from 'wxt/browser';
// Import from core's pure network-config subpath, NOT the moth-browser barrel:
// the barrel drags in the ledger WASM (top-level await), which cannot exist in
// the service worker's module graph. See lib/offscreen for where WASM lives.
import {
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
  // A real timeout by default; users opt into "Never (demo mode)" explicitly.
  autoLockMinutes: 15,
  // Send-to-name is opt-in: no resolver configured until the user sets one.
  nameResolverUrl: null,
  // Opt-in: warming costs a full chain walk in the background (~71 min on
  // preprod). Never start that without the user asking for it.
  preseedWarming: false,
  // Diagnostic detail is opt-in; the plain warning it augments is not.
  developerMode: false,
};

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

/** Accept a stored auto-lock value, tolerating legacy/absent settings.
 *  `null` is a valid, deliberate value (demo mode); `undefined` → default. */
function parseAutoLock(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_SETTINGS.autoLockMinutes;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  const customEndpoints = parseEndpoints(saved?.customEndpoints);
  return {
    network: saved?.network ?? DEFAULT_SETTINGS.network,
    customEndpoints,
    autoLockMinutes: 'autoLockMinutes' in (saved ?? {}) ? parseAutoLock(saved?.autoLockMinutes) : DEFAULT_SETTINGS.autoLockMinutes,
    nameResolverUrl: parseResolverUrl(saved?.nameResolverUrl),
    preseedWarming: saved?.preseedWarming === true,
    developerMode: saved?.developerMode === true,
  };
}

export async function updateSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  // Endpoint overrides belong to one named network. Callers that change only
  // the id must never carry the previous network's URLs across implicitly.
  if (patch.network && patch.network !== current.network && !('customEndpoints' in patch)) {
    next.customEndpoints = null;
  }
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Resolve endpoints for a network. Saved overrides only belong to the selected
 * settings network; explicit lookups for other networks use their presets.
 */
export async function getNetworkConfig(networkId?: string): Promise<NetworkConfig> {
  const { network: settingsNetwork, customEndpoints } = await getSettings();
  const network = networkId ?? settingsNetwork;
  const base = DEFAULT_NETWORKS[network] ?? {
    id: network,
    nodeUrl: 'ws://localhost:9944',
    indexerUrl: 'http://localhost:8088',
    prover: serverProver(),
  };
  if (!customEndpoints || network !== settingsNetwork) return base;
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
