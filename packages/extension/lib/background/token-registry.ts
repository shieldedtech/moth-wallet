// Background side of the Gloam token registry: reads the opt-in setting and
// hands held colours to the offscreen document, which fetches the registry
// (full list or held buckets — never per colour) and re-derives each matching
// entry's colour with the ledger before it is shown. Never throws: a missing
// setting, an unreachable registry or a malformed list all yield an empty map,
// and the Home screen falls back to truncated token ids.

import type { NetworkConfig } from '@shieldedtech/moth-wallet/types/network';
import type { ExtensionSettings, RegistryToken } from '../messaging/protocol';

const HEX32 = /^[0-9a-f]{64}$/;
/** Upper bound on colours forwarded per call — a guard against a runaway caller, not a product limit. */
const MAX_COLORS = 512;

export interface TokenRegistryDeps {
  getSettings(): Promise<ExtensionSettings>;
  getNetworkConfig(): Promise<NetworkConfig>;
  resolve(data: { network: NetworkConfig; baseUrl: string; useBuckets: boolean; colors: string[] }): Promise<Record<string, RegistryToken>>;
}

export async function tokenRegistryGet(colors: readonly string[], deps: TokenRegistryDeps): Promise<Record<string, RegistryToken>> {
  const { tokenRegistryUrl, tokenRegistryBuckets } = await deps.getSettings();
  if (!tokenRegistryUrl) return {};
  const held = [...new Set(colors.map((c) => c.toLowerCase()).filter((c) => HEX32.test(c)))].slice(0, MAX_COLORS);
  if (held.length === 0) return {};
  try {
    return await deps.resolve({
      network: await deps.getNetworkConfig(),
      baseUrl: tokenRegistryUrl,
      useBuckets: tokenRegistryBuckets,
      colors: held,
    });
  } catch {
    return {};
  }
}
