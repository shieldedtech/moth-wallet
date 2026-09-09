// Address derivation for Midnight wallets.
// Uses the same derivation as mn-tui and the official wallet SDK.
// See NOTICE for attribution to mn-tui (Apache-2.0).

import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
import {ZswapSecretKeys, DustSecretKey} from '@midnight-ntwrk/ledger-v8';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk/address-format';
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import type {WalletAddresses} from '../types/wallet.js';

/**
 * Every bech32m prefix a wallet may hold an address for.
 *
 * Deliberately WIDER than `SUPPORTED_NETWORKS` in types/network.ts, and not to
 * be narrowed to match it. Two kinds of id live here without being a network the
 * wallet offers: `stagenet`, which has no preset, and `local`, which was renamed
 * to `undeployed`. Dropping either would take its key out of every bundle
 * derived from then on, so a stored address a dApp or an address book still
 * refers to would resolve to nothing.
 */
const ALL_NETWORKS = ['mainnet', 'devnet', 'preview', 'preprod', 'qanet', 'stagenet', 'local', 'undeployed'] as const;

export {Roles};

/**
 * Derive raw HD keys from a hex seed using the wallet SDK's HDWallet.
 */
export function deriveRawKeys(seedHex: string): Record<number, Uint8Array> {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.NightExternal, Roles.NightInternal, Roles.Dust, Roles.Zswap, Roles.Metadata] as const)
    .deriveKeysAt(0);

  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b: number) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive proper Midnight addresses for a specific network.
 *
 * - Unshielded: createKeystore(secretKey) → Ed25519 public key → bech32m
 * - Shielded: ZswapSecretKeys.fromSeed() → coin + encryption public keys
 * - DUST: DustSecretKey.fromSeed() → public key → DustAddress
 */
function deriveForNetwork(keys: Record<number, Uint8Array>, network: string) {
  setNetworkId(network);

  const unshielded: string = (createKeystore(keys[Roles.NightExternal], network).getBech32Address() as any).toString();

  const unshieldedInternal: string = (
    createKeystore(keys[Roles.NightInternal], network).getBech32Address() as any
  ).toString();

  const zswapKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const shielded: string = (
    MidnightBech32m.encode(
      network,
      new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(zswapKeys.encryptionPublicKey)
      )
    ) as any
  ).toString();

  const dustKey = DustSecretKey.fromSeed(keys[Roles.Dust]);
  const dust: string = DustAddress.encodePublicKey(network, dustKey.publicKey);

  const metadata: string = (createKeystore(keys[Roles.Metadata], network).getBech32Address() as any).toString();

  return {unshielded, unshieldedInternal, shielded, dust, metadata};
}

/**
 * Derive all Midnight addresses from a hex seed, for all networks.
 */
export function deriveAllAddressesFromSeed(seedHex: string): WalletAddresses {
  const keys = deriveRawKeys(seedHex);

  const ne: Record<string, string> = {};
  const ni: Record<string, string> = {};
  const du: Record<string, string> = {};
  const zs: Record<string, string> = {};
  const md: Record<string, string> = {};

  for (const network of ALL_NETWORKS) {
    const addrs = deriveForNetwork(keys, network);
    ne[network] = addrs.unshielded;
    ni[network] = addrs.unshieldedInternal;
    du[network] = addrs.dust;
    zs[network] = addrs.shielded;
    md[network] = addrs.metadata;
  }

  // SECURITY: Do NOT expose raw role key bytes as hex — those are private keys.
  // Only public address encodings (bech32m) are safe to display/store/transmit.
  return {
    nightExternal: {hex: '', bech32m: ne},
    nightInternal: {hex: '', bech32m: ni},
    dust: {hex: '', bech32m: du},
    zswap: {hex: '', bech32m: zs},
    metadata: {hex: '', bech32m: md},
  };
}

/**
 * Derive the shielded (Zswap) coin + encryption PUBLIC keys from a hex seed,
 * as canonical hex strings. These are public keys (network-independent, the
 * same across all networks) and are safe to expose to a connected dApp — unlike
 * the raw role key bytes. The combined, network-scoped shielded address is
 * available separately via {@link deriveAllAddressesFromSeed} (`zswap`).
 */
export function deriveShieldedPublicKeys(seedHex: string): {
  coinPublicKey: string;
  encryptionPublicKey: string;
} {
  const keys = deriveRawKeys(seedHex);
  const zswapKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  return {
    coinPublicKey: zswapKeys.coinPublicKey,
    encryptionPublicKey: zswapKeys.encryptionPublicKey,
  };
}

/**
 * @deprecated Use deriveAllAddressesFromSeed with the hex seed.
 */
export function deriveAllAddresses(): WalletAddresses {
  throw new Error('deriveAllAddresses is deprecated — use deriveAllAddressesFromSeed(seedHex)');
}

/**
 * Re-encode an address for a different network.
 *
 * A Midnight address is a payload plus a network HRP; the payload is the key
 * material and carries no network of its own. So the same wallet's unshielded
 * address on devnet and on preprod differ only in prefix and checksum —
 * `mn_addr_devnet18ph9d9…eskkpdrr` and `mn_addr_preprod18ph9d9…esngsypp` both
 * decode to `386e5697…97c73`.
 *
 * That matters because `WalletMeta.address` is written once, at create or import,
 * with whichever network was current then. A wallet created on devnet and since
 * used on preprod still reports its devnet address, and a caller that forwards it
 * — `moth dust status` did — sends a wrong-network address wherever it goes
 * (#107). Re-encoding needs no keys, so the correct address for the network being
 * asked about is always available without an unlock.
 *
 * Returns null when the input cannot be parsed or re-encoded, so a caller can
 * fall back to the stored value rather than lose the field entirely.
 */
export function addressForNetwork(address: string, network: string): string | null {
  try {
    const parsed = MidnightBech32m.parse(address);
    const current = typeof parsed.network === 'symbol' ? 'mainnet' : String(parsed.network);
    if (current === network) return address;
    return (MidnightBech32m.encode(network, parsed.decode(UnshieldedAddress, current as never)) as any).toString();
  } catch {
    return null;
  }
}

export function decodeBech32mAddress(address: string): {
  type: string;
  network: string;
  data: Uint8Array;
} {
  const parsed = MidnightBech32m.parse(address);
  return {
    type: parsed.type,
    network: typeof parsed.network === 'symbol' ? 'mainnet' : String(parsed.network),
    data: new Uint8Array(parsed.data),
  };
}
