import { validateNetworkUrl } from '../types/network.js';

/**
 * Cardano networks the cNIGHT contracts are deployed to. These are Lucid's own
 * network names, spelled exactly as Lucid expects them, so the value can be
 * handed straight to `Lucid(...)` without a translation table.
 */
export type CardanoNetwork = 'Mainnet' | 'Preprod' | 'Preview';

export const CARDANO_NETWORKS: readonly CardanoNetwork[] = ['Mainnet', 'Preprod', 'Preview'];

export interface CardanoNetworkConfig {
  readonly network: CardanoNetwork;
  /** Cardano's own network id: 1 for mainnet, 0 for every testnet. */
  readonly networkId: 0 | 1;
  readonly blockfrostUrl: string;
  /**
   * Blockfrost project id. Optional in the type because address and policy
   * derivation are pure and need no API at all — only the paths that actually
   * touch the chain require it, and they say so by name.
   * SECRET — never log it, never include it in diagnostics.
   */
  readonly blockfrostProjectId?: string;
  /** cNIGHT minting policy id (hex). */
  readonly cnightPolicyId: string;
  /** cNIGHT asset name, hex-encoded. Empty on the testnet dummy token. */
  readonly cnightAssetName: string;
  readonly explorerUrl: string;
}

/**
 * Per-network defaults, mirroring the cNIGHT-to-DUST dApp's deployment config.
 *
 * The testnet policy id is the dummy cNIGHT minted by the test scripts, which
 * is why Preview and Preprod share one: it is the same throwaway token on both.
 * Mainnet's is the real asset, and carries a real asset name ("NIGHT") where
 * the dummy has none.
 *
 * All of it is overridable — see `resolveCardanoNetwork` — because a redeploy
 * moves the policy id and a wallet release should not be what gates catching up.
 */
const DEFAULTS: Record<CardanoNetwork, Omit<CardanoNetworkConfig, 'blockfrostProjectId'>> = {
  Mainnet: {
    network: 'Mainnet',
    networkId: 1,
    blockfrostUrl: 'https://cardano-mainnet.blockfrost.io/api/v0',
    cnightPolicyId: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa',
    cnightAssetName: '4e49474854',
    explorerUrl: 'https://cexplorer.io',
  },
  Preprod: {
    network: 'Preprod',
    networkId: 0,
    blockfrostUrl: 'https://cardano-preprod.blockfrost.io/api/v0',
    cnightPolicyId: 'd2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1',
    cnightAssetName: '',
    explorerUrl: 'https://preprod.cexplorer.io',
  },
  Preview: {
    network: 'Preview',
    networkId: 0,
    blockfrostUrl: 'https://cardano-preview.blockfrost.io/api/v0',
    cnightPolicyId: 'd2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1',
    cnightAssetName: '',
    explorerUrl: 'https://preview.cexplorer.io',
  },
};

/**
 * The Cardano network a given Midnight network pairs with, or null when it has
 * none.
 *
 * Derived, never chosen. A registration maps a Cardano stake key to a Midnight
 * DUST key, and only the bridge between *that* pair of chains will ever act on
 * it. Letting the two be selected independently produced exactly one outcome
 * in practice: cNIGHT registered on Cardano Preview against a Midnight preprod
 * wallet, which is well-formed on Cardano, invisible to Midnight, and gives no
 * feedback for the twelve hours you spend waiting for DUST that cannot arrive.
 *
 * devnet, qanet and undeployed return null rather than falling back to a
 * testnet. They have no Cardano counterpart, and quietly pointing them at
 * Preview is the same class of mistake with a different pair of names.
 */
export function cardanoNetworkFor(midnightNetworkId: string): CardanoNetwork | null {
  switch (midnightNetworkId) {
    case 'mainnet': return 'Mainnet';
    case 'preprod': return 'Preprod';
    case 'preview': return 'Preview';
    default: return null;
  }
}

/** Thrown when a Midnight network has no Cardano counterpart at all. */
export class CardanoNetworkUnavailableError extends Error {
  constructor(midnightNetworkId: string) {
    super(
      `There is no Cardano network paired with Midnight ${midnightNetworkId}. `
        + 'cNIGHT lives on Cardano mainnet, preprod and preview only.',
    );
    this.name = 'CardanoNetworkUnavailableError';
  }
}

/**
 * Deployment overrides. Note what is absent: the Cardano network itself, which
 * is derived from the Midnight network and must not be selectable.
 */
export interface CardanoNetworkOverrides {
  readonly blockfrostUrl?: string;
  readonly blockfrostProjectId?: string;
  readonly cnightPolicyId?: string;
  readonly cnightAssetName?: string;
}

function assertHex(value: string, label: string): void {
  if (!/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${label} must be hex-encoded, got "${value}"`);
  }
  if (value.length % 2 !== 0) {
    throw new Error(`${label} must have an even number of hex digits, got "${value}"`);
  }
}

/**
 * Build the effective Cardano config for a Midnight network, applying any
 * overrides on top of the deployment defaults.
 */
export function resolveCardanoNetwork(
  midnightNetworkId: string,
  overrides: CardanoNetworkOverrides = {},
): CardanoNetworkConfig {
  const network = cardanoNetworkFor(midnightNetworkId);
  if (!network) throw new CardanoNetworkUnavailableError(midnightNetworkId);
  const base = DEFAULTS[network];

  const blockfrostUrl = overrides.blockfrostUrl ?? base.blockfrostUrl;
  validateNetworkUrl(blockfrostUrl, 'Blockfrost URL');

  const cnightPolicyId = overrides.cnightPolicyId ?? base.cnightPolicyId;
  assertHex(cnightPolicyId, 'cNIGHT policy id');
  if (cnightPolicyId.length !== 56) {
    throw new Error(`cNIGHT policy id must be 28 bytes (56 hex chars), got ${cnightPolicyId.length}`);
  }

  const cnightAssetName = overrides.cnightAssetName ?? base.cnightAssetName;
  assertHex(cnightAssetName, 'cNIGHT asset name');

  return {
    ...base,
    blockfrostUrl,
    cnightPolicyId,
    cnightAssetName,
    ...(overrides.blockfrostProjectId ? { blockfrostProjectId: overrides.blockfrostProjectId } : {}),
  };
}

/** Lucid's "unit": the policy id and asset name concatenated. */
export function cnightUnit(config: CardanoNetworkConfig): string {
  return config.cnightPolicyId + config.cnightAssetName;
}

export function explorerTxUrl(config: CardanoNetworkConfig, txHash: string): string {
  return `${config.explorerUrl}/tx/${txHash}`;
}

export function explorerAddressUrl(config: CardanoNetworkConfig, address: string): string {
  return `${config.explorerUrl}/addr/${address}`;
}
