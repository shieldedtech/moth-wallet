import { canonicalNetworkId } from '@shieldedtech/moth-wallet';
import type { ProverConfig, StorageAdapter } from '@shieldedtech/moth-wallet';

const SETTINGS_KEY = 'tui/settings.json';

export interface NetworkOverrides {
  nodeUrl?: string;
  indexerUrl?: string;
  prover?: ProverConfig;
  /** @deprecated Migrated when the network is next loaded. */
  proofServerUrl?: string;
}

export interface TuiSettings {
  lastNetwork: string;
  lastWallet: string | null;
  networkOverrides: Record<string, NetworkOverrides>;
}

const DEFAULTS: TuiSettings = {
  lastNetwork: 'devnet',
  lastWallet: null,
  networkOverrides: {},
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Re-key per-network endpoint overrides onto the ids in use today.
 *
 * Without this the session loses them on the SECOND launch rather than the
 * first, which is the harder failure to spot: the first launch still finds the
 * entry under the old name and persists `lastNetwork` as the new one, so the
 * next launch looks up a key nothing is filed under and quietly falls back to
 * the preset endpoints — including dropping a WASM prover choice.
 *
 * An entry already stored under a current name wins over one being renamed onto
 * it: it was saved against the name in use, so it is the more deliberate of the
 * two. Nothing else can distinguish them.
 */
function canonicalOverrides(saved: Record<string, NetworkOverrides> = {}): Record<string, NetworkOverrides> {
  const out: Record<string, NetworkOverrides> = {};
  for (const [id, overrides] of Object.entries(saved)) {
    if (canonicalNetworkId(id) === id) out[id] = overrides;
  }
  for (const [id, overrides] of Object.entries(saved)) {
    const key = canonicalNetworkId(id);
    if (key !== id && out[key] === undefined) out[key] = overrides;
  }
  return out;
}

export async function loadSettings(storage: StorageAdapter): Promise<TuiSettings> {
  const data = await storage.read(SETTINGS_KEY);
  if (!data) return { ...DEFAULTS };
  try {
    const saved: TuiSettings = { ...DEFAULTS, ...JSON.parse(decoder.decode(data)) };
    return {
      ...saved,
      lastNetwork: canonicalNetworkId(saved.lastNetwork),
      networkOverrides: canonicalOverrides(saved.networkOverrides),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(storage: StorageAdapter, settings: TuiSettings): Promise<void> {
  await storage.write(SETTINGS_KEY, encoder.encode(JSON.stringify(settings, null, 2)));
}
