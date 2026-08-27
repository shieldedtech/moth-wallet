// Address derivation for Midnight wallets.
// Uses the same derivation as mn-tui and the official wallet SDK.
// See NOTICE for attribution to mn-tui (Apache-2.0).

import {HDWallet, Roles} from '@midnightntwrk/wallet-sdk/hd';
// Derivation is taken from v8 directly rather than through the ledger seam, and
// deliberately so. fromSeed is fork-invariant — v8 and v9 produce byte-identical
// coin, encryption and DUST public keys from the same seed, pinned by
// tests/unit/ledger/derivation-invariance.test.ts. This function also derives for
// every network at once, spanning both ledger generations, so there is no single
// "current" ledger it could ask for. It is safe here only because the derived
// objects never leave: their public key *values* are read and encoded as bech32m.
// Code that passes a ZswapSecretKeys or DustSecretKey object on into transaction
// machinery must use the seam, since the two ledgers' classes are distinct.
import {ZswapSecretKeys, DustSecretKey} from '@midnight-ntwrk/ledger-v8';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
  MidnightBech32m,
} from '@midnightntwrk/wallet-sdk/address-format';
// Direct, not through the SDK seam, for the same reason the ledger import above
// is direct: measured fork-invariant. The v8 and v9 SDKs derive the same
// unshielded bech32m address from the same seed, and this function only reads
// the address off the keystore — it never signs. Code that signs must use
// createKeystoreFor, since the signature bytes do differ.
import {createKeystore} from '@midnightntwrk/wallet-sdk/unshielded';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import type {WalletAddresses} from '../types/wallet.js';
import type {SignatureKind} from './signature-encoding.js';
import {createKeystoreFor} from '../sdk/index.js';
import {DEFAULT_NETWORKS, resolveLedgerVersion} from '../types/network.js';

/**
 * Every bech32m prefix a wallet may hold an address for.
 *
 * Deliberately WIDER than `SUPPORTED_NETWORKS` in types/network.ts, and not to
 * be narrowed to match it. The retired `local` id lives here without being a
 * network the wallet offers because it was renamed to `undeployed`. Dropping it
 * would take its key out of every bundle derived from then on, so a stored
 * address a dApp or an address book still refers to would resolve to nothing.
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
/** ECDSA exists only on ledger v9, so a v8 network has no ECDSA address at all. */
function networkLedger(network: string) {
  const preset = DEFAULT_NETWORKS[network];
  return preset ? resolveLedgerVersion(preset) : 'v8';
}

/**
 * Unshielded addresses depend on the signature kind; shielded and DUST do not.
 * Schnorr takes the direct v8 path, which needs no SDK loaded because the two
 * generations derive identical addresses. ECDSA has to go through the seam,
 * since v8 has no such concept.
 */
function unshieldedFor(secret: Uint8Array, network: string, kind: SignatureKind): string {
  if (kind === 'schnorr') return (createKeystore(secret, network).getBech32Address() as any).toString();
  return (createKeystoreFor(secret, network, 'ecdsa').getBech32Address() as any).toString();
}

function deriveForNetwork(keys: Record<number, Uint8Array>, network: string, kind: SignatureKind) {
  setNetworkId(network);

  // An ECDSA wallet simply has no unshielded identity on a v8 network. Emitting
  // one would mean showing an address that can never receive.
  const unshieldedUsable = kind === 'schnorr' || networkLedger(network) === 'v9';

  const unshielded: string = unshieldedUsable ? unshieldedFor(keys[Roles.NightExternal], network, kind) : '';

  const unshieldedInternal: string = unshieldedUsable
    ? unshieldedFor(keys[Roles.NightInternal], network, kind)
    : '';

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

  const metadata: string = unshieldedUsable ? unshieldedFor(keys[Roles.Metadata], network, kind) : '';

  return {unshielded, unshieldedInternal, shielded, dust, metadata};
}

/**
 * Derive all Midnight addresses from a hex seed, for all networks.
 */
export function deriveAllAddressesFromSeed(
  seedHex: string,
  kind: SignatureKind = 'schnorr',
): WalletAddresses {
  const keys = deriveRawKeys(seedHex);

  const ne: Record<string, string> = {};
  const ni: Record<string, string> = {};
  const du: Record<string, string> = {};
  const zs: Record<string, string> = {};
  const md: Record<string, string> = {};

  for (const network of ALL_NETWORKS) {
    const addrs = deriveForNetwork(keys, network, kind);
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
