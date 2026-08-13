import { describe, expect, it } from 'vitest';
import {
  MAINNET_NATIVE_ASSET_LABELS,
  TESTNET_NATIVE_ASSET_LABELS,
  nativeAssetLabelsForNetwork,
} from '../lib/ui/token-labels';

// Mainnet carries real value, so calling its assets tNIGHT/tDUST is not a
// cosmetic slip — it tells someone their funds are test funds.
describe('nativeAssetLabelsForNetwork', () => {
  it('uses production names on mainnet', () => {
    expect(nativeAssetLabelsForNetwork('mainnet')).toEqual({ night: 'NIGHT', dust: 'DUST' });
  });

  it('tolerates case and surrounding whitespace', () => {
    // Network ids reach this from stored settings and from message payloads;
    // neither is guaranteed to be normalised.
    for (const id of ['MAINNET', ' mainnet ', 'MainNet']) {
      expect(nativeAssetLabelsForNetwork(id)).toEqual(MAINNET_NATIVE_ASSET_LABELS);
    }
  });

  it('uses testnet names everywhere else', () => {
    for (const id of ['preprod', 'preview', 'devnet', 'qanet', 'local']) {
      expect(nativeAssetLabelsForNetwork(id)).toEqual(TESTNET_NATIVE_ASSET_LABELS);
    }
  });

  it('falls back to testnet names for an unknown network', () => {
    // Safer direction: calling real assets "test" understates, calling test
    // assets "real" could persuade someone to send funds they cannot recover.
    expect(nativeAssetLabelsForNetwork('some-future-net')).toEqual(TESTNET_NATIVE_ASSET_LABELS);
    expect(nativeAssetLabelsForNetwork('')).toEqual(TESTNET_NATIVE_ASSET_LABELS);
  });
});
