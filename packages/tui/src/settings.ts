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

export async function loadSettings(storage: StorageAdapter): Promise<TuiSettings> {
  const data = await storage.read(SETTINGS_KEY);
  if (!data) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(decoder.decode(data)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(storage: StorageAdapter, settings: TuiSettings): Promise<void> {
  await storage.write(SETTINGS_KEY, encoder.encode(JSON.stringify(settings, null, 2)));
}
