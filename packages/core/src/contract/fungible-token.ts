// Bundled minimal fungible-token issuer (moth-ft).
//
// Lets the wallet auto-deploy a token contract and mint ledger tokens (shielded
// or unshielded) to a target recipient without the user supplying a compiled
// artifact. The contract ships in this package in two builds, one per ledger
// era (see bundled.ts): a deploy takes the build for the network's era, and a
// mint takes the build the contract's verifier keys come from.
//
// The contract exposes two circuits (see contracts/moth-ft/moth-ft.compact):
//   mintShielded(recipient: { bytes }, value: bigint)   -> ShieldedCoinInfo
//   mintUnshielded(recipient: { bytes }, value: bigint) -> token color bytes
// It has no witnesses, no constructor args, and initial private state `{}`.

import {
  MidnightBech32m,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk/address-format';
import { loadContractArtifact } from './artifact-loader.js';
import { deployContract } from './deploy.js';
import { callCircuit } from './call.js';
import {
  BUNDLED_CONTRACT_PROJECT_DIR,
  bundledContractForAddress,
  bundledContractForDeploy,
} from './bundled.js';
import { InvalidInputError } from '../types/errors.js';
import type { DerivedKeys, WalletKeys } from '../types/wallet.js';
import type { NetworkConfig } from '../types/network.js';
import type { TransactionResult } from '../types/transaction.js';
import type { SyncedWallet } from '../sync/wallet-sync.js';

export interface DeployFungibleTokenOptions {
  walletKeys: WalletKeys;
  network: NetworkConfig;
  syncedWallet: SyncedWallet;
  timeoutMs?: number;
  onProgress?: (stage: string) => void;
}

/**
 * Deploy the bundled fungible-token issuer contract, built for the ledger era
 * the network is on. The returned `TransactionResult.contractAddress` is the
 * address to mint against.
 */
export async function deployFungibleToken(options: DeployFungibleTokenOptions): Promise<TransactionResult> {
  const build = await bundledContractForDeploy('moth-ft', options.network);
  const artifact = await loadContractArtifact(build.artifactPath);
  return deployContract({
    artifact,
    walletKeys: options.walletKeys,
    network: options.network,
    syncedWallet: options.syncedWallet,
    projectDir: BUNDLED_CONTRACT_PROJECT_DIR,
    timeoutMs: options.timeoutMs,
    onProgress: options.onProgress,
  });
}

export interface MintFungibleTokenOptions {
  /** Address of a deployed moth-ft contract. */
  contractAddress: string;
  /**
   * Bech32m recipient address. A shielded address (`mn_shield-addr…`) when
   * `shielded` is true, otherwise an unshielded user address (`mn_addr…`).
   */
  recipientAddress: string;
  amount: bigint;
  shielded: boolean;
  keys: DerivedKeys;
  walletKeys: WalletKeys;
  network: NetworkConfig;
  syncedWallet: SyncedWallet;
  timeoutMs?: number;
}

/**
 * Mint `amount` ledger tokens of a deployed moth-ft contract to `recipientAddress`.
 * Calls `mintShielded` or `mintUnshielded` depending on `shielded`.
 */
export async function mintFungibleToken(options: MintFungibleTokenOptions): Promise<TransactionResult> {
  const { contractAddress, recipientAddress, amount, shielded, network } = options;

  const recipient = shielded
    ? decodeShieldedRecipient(recipientAddress, network.id)
    : decodeUnshieldedRecipient(recipientAddress, network.id);
  const build = await bundledContractForAddress('moth-ft', contractAddress, network);

  return callCircuit({
    contractAddress,
    circuitName: shielded ? 'mintShielded' : 'mintUnshielded',
    args: [recipient, amount],
    keys: options.keys,
    walletKeys: options.walletKeys,
    network,
    artifactPath: build.artifactPath,
    syncedWallet: options.syncedWallet,
    projectDir: BUNDLED_CONTRACT_PROJECT_DIR,
    timeoutMs: options.timeoutMs,
  });
}

// Decode a shielded bech32m address to the contract's `{ bytes }` recipient arg
// (the zswap coin public key). Field access mirrors the execution-verified path.
function decodeShieldedRecipient(address: string, networkId: string): { bytes: Uint8Array } {
  try {
    const decoded = MidnightBech32m.parse(address).decode(ShieldedAddress, networkId as never);
    return { bytes: new Uint8Array((decoded as { coinPublicKey: { data: Uint8Array } }).coinPublicKey.data) };
  } catch (err) {
    throw new InvalidInputError(
      `Invalid shielded recipient address for minting (expected mn_shield-addr…): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Decode an unshielded bech32m user address to the contract's `{ bytes }` recipient arg.
function decodeUnshieldedRecipient(address: string, networkId: string): { bytes: Uint8Array } {
  try {
    const decoded = MidnightBech32m.parse(address).decode(UnshieldedAddress, networkId as never);
    return { bytes: new Uint8Array((decoded as { data: Uint8Array }).data) };
  } catch (err) {
    throw new InvalidInputError(
      `Invalid unshielded recipient address for minting (expected mn_addr…): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
