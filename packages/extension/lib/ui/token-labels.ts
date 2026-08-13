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
