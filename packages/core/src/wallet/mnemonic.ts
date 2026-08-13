import * as bip39 from '@scure/bip39';
import {
  generateMnemonicWords,
  joinMnemonicWords,
  validateMnemonic as sdkValidateMnemonic,
} from '@midnightntwrk/wallet-sdk/hd';

export function generateMnemonic24(): string {
  return joinMnemonicWords(generateMnemonicWords(256));
}

export function validateMnemonic(mnemonic: string): boolean {
  if (!mnemonic || mnemonic.trim().length === 0) return false;
  return sdkValidateMnemonic(mnemonic);
}

// SDK gap: @midnightntwrk/wallet-sdk-* does not expose mnemonic → seed.
export async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
  return bip39.mnemonicToSeedSync(mnemonic);
}

export function hexSeedToUint8Array(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hex characters');
  }
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
