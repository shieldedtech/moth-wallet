import type { StorageAdapter } from '../storage/adapter.js';
import {
  cardanoNetworkFor,
  resolveCardanoNetwork,
  type CardanoNetworkConfig,
  type CardanoNetworkOverrides,
} from './network.js';

/**
 * Storage key for a network's Blockfrost project id.
 *
 * Per network, because a Blockfrost project id is issued for one network and
 * rejected by the others — a preview key against the preprod endpoint is a
 * 403, not a fallback. A single shared key meant switching networks silently
 * carried the wrong credential.
 */
export function blockfrostProjectIdKey(cardanoNetwork: string): string {
  return `blockfrost-project-id-${cardanoNetwork.toLowerCase()}`;
}

/** Environment variable holding a network's Blockfrost project id. */
export function blockfrostProjectIdEnv(cardanoNetwork: string): string {
  return `MOTH_BLOCKFROST_PROJECT_ID_${cardanoNetwork.toUpperCase()}`;
}

/**
 * Precedence for every Cardano setting: explicit override (a CLI flag), then
 * environment, then stored config, then the deployment default for whichever
 * Cardano network pairs with the Midnight one.
 *
 * Shared by the CLI, the TUI and `daemon serve` so a `moth config set` is
 * honoured identically wherever the transaction is actually built — three
 * copies of this ladder would drift, and the symptom would be a registration
 * against the wrong policy id.
 */
export async function loadCardanoConfig(
  storage: Pick<StorageAdapter, 'read'>,
  midnightNetworkId: string,
  overrides: CardanoNetworkOverrides = {},
): Promise<CardanoNetworkConfig> {
  const decoder = new TextDecoder();
  const persisted = async (key: string): Promise<string | undefined> => {
    try {
      const data = await storage.read(`config/${key}`);
      return data ? decoder.decode(data) : undefined;
    } catch {
      return undefined;
    }
  };

  // No cardano-network override, by design: the pairing is derived from the
  // Midnight network. See cardanoNetworkFor.
  // Needed before resolution: the project id is looked up by Cardano network.
  // Null here means this Midnight network has no counterpart, and
  // resolveCardanoNetwork is what reports that.
  const cardanoNetwork = cardanoNetworkFor(midnightNetworkId) ?? '';

  return resolveCardanoNetwork(midnightNetworkId, {
    blockfrostUrl:
      overrides.blockfrostUrl
      ?? process.env.MOTH_BLOCKFROST_URL
      ?? (await persisted('blockfrost-url')),
    // Not overridable by flag anywhere: a credential passed as a flag is
    // readable from the process list by any other user on the machine.
    //
    // Looked up per network first. The unsuffixed key and env var are kept as a
    // fallback so a single-network setup made before this split keeps working.
    blockfrostProjectId:
      process.env[blockfrostProjectIdEnv(cardanoNetwork)]
      ?? (await persisted(blockfrostProjectIdKey(cardanoNetwork)))
      ?? process.env.MOTH_BLOCKFROST_PROJECT_ID
      ?? (await persisted('blockfrost-project-id')),
    cnightPolicyId: overrides.cnightPolicyId ?? (await persisted('cnight-policy-id')),
    cnightAssetName: overrides.cnightAssetName ?? (await persisted('cnight-asset-name')),
  });
}
