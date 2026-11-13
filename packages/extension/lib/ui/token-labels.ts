/** Labels used for Midnight's native assets throughout the extension UI. */
export interface NativeAssetLabels {
  night: string;
  dust: string;
}

/** The wallet SDK sub-wallet name is network-independent. */
export const DUST_WALLET_LABEL = 'DUST';

export const MAINNET_NATIVE_ASSET_LABELS: NativeAssetLabels = {
  night: 'NIGHT',
  dust: 'DUST',
};

export const TESTNET_NATIVE_ASSET_LABELS: NativeAssetLabels = {
  night: 'tNIGHT',
  dust: 'tDUST',
};

/** Mainnet uses the production asset names; every other network uses testnet names. */
export function nativeAssetLabelsForNetwork(network: string): NativeAssetLabels {
  return network.trim().toLowerCase() === 'mainnet' ? MAINNET_NATIVE_ASSET_LABELS : TESTNET_NATIVE_ASSET_LABELS;
}

/** A token id shortened to a readable handle. */
export function shortTokenId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * What to call a token on screen: the name the user gave it, or a short id.
 *
 * One definition because four screens needed it and had grown four copies —
 * which is how the activity feed came to show a raw id for a token the asset
 * list already named. Lookup is exact, as every other screen's is: ids reach
 * the UI from one SDK state, and normalising in one screen only would make it
 * disagree with the rest.
 */
export function tokenDisplayName(id: string, names?: Record<string, string>): string {
  return names?.[id] || shortTokenId(id);
}
