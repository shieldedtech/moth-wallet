import type { LucidEvolution } from '@lucid-evolution/lucid';
import { InvalidInputError, NetworkError, WalletError } from '../types/errors.js';
import type { CardanoNetworkConfig } from './network.js';

/**
 * Default account index in the CIP-1852 path
 * (m/1852'/1815'/account'/role/index).
 *
 * Callers that manage multiple Cardano accounts pass their own. Getting it
 * wrong is quiet rather than loud: the derivation succeeds and produces a
 * perfectly valid address that simply holds none of your cNIGHT, and the
 * failure surfaces as "no cNIGHT found" a step later.
 */
export const DEFAULT_CARDANO_ACCOUNT_INDEX = 0;

export interface CardanoAddresses {
  /** CIP-1852 base address — payment credential with the stake credential attached. */
  readonly address: string;
  /** Reward (stake) address. This is the key the indexer reports DUST against. */
  readonly rewardAddress: string;
  /** Stake key hash, 28 bytes hex. What the registration datum records. */
  readonly stakeKeyHash: string;
  /** Payment key hash, 28 bytes hex. */
  readonly paymentKeyHash: string;
}

/**
 * Moth wallets restored from a raw hex seed have no mnemonic — one never
 * existed. Cardano's CIP-1852 derivation starts from BIP-39 *entropy*, which a
 * 64-byte seed cannot be reversed into, so those wallets have no Cardano
 * identity at all. This is a property of the derivation, not a missing feature.
 */
export class CardanoKeysUnavailableError extends WalletError {
  constructor(walletName: string) {
    super(
      'WALLET_ERROR',
      `Wallet "${walletName}" was imported from a raw hex seed, so it has no Cardano address.`,
    );
    this.name = 'CardanoKeysUnavailableError';
  }
}

export class BlockfrostKeyMissingError extends WalletError {
  constructor() {
    super(
      'INVALID_INPUT',
      'No Blockfrost project id configured. Cardano reads and transactions need one.',
    );
    this.name = 'BlockfrostKeyMissingError';
  }
}

/**
 * Derive a wallet's Cardano addresses. Pure — no network, no provider, so this
 * is safe to call just to show someone where to send ADA.
 */
export async function deriveCardanoAddresses(
  mnemonic: string,
  config: CardanoNetworkConfig,
  accountIndex: number = DEFAULT_CARDANO_ACCOUNT_INDEX,
): Promise<CardanoAddresses> {
  const { walletFromSeed, getAddressDetails } = await import('@lucid-evolution/lucid');
  const seeded = walletFromSeed(mnemonic, {
    addressType: 'Base',
    accountIndex,
    network: config.network,
  });
  if (!seeded.rewardAddress) {
    // Base addresses always carry a stake credential; reaching here would mean
    // Lucid handed back an enterprise address despite being asked for Base.
    throw new InvalidInputError('Cardano derivation produced no reward address');
  }
  const details = getAddressDetails(seeded.address);
  const paymentKeyHash = details.paymentCredential?.hash;
  const stakeKeyHash = details.stakeCredential?.hash;
  if (!paymentKeyHash || !stakeKeyHash) {
    throw new InvalidInputError('Cardano derivation produced an address without both credentials');
  }
  return {
    address: seeded.address,
    rewardAddress: seeded.rewardAddress,
    stakeKeyHash,
    paymentKeyHash,
  };
}

export interface CardanoSession {
  readonly lucid: LucidEvolution;
  readonly addresses: CardanoAddresses;
  readonly config: CardanoNetworkConfig;
}

/**
 * Open a Lucid session against Blockfrost with the wallet selected, run `fn`,
 * and tear the session down.
 *
 * The mnemonic is handed to Lucid and otherwise not retained here. Callers own
 * the string they pass in and should scrub their own copy — a JS string cannot
 * be zeroed from inside this function.
 */
export async function withCardanoSession<T>(
  mnemonic: string,
  config: CardanoNetworkConfig,
  fn: (session: CardanoSession) => Promise<T>,
  accountIndex: number = DEFAULT_CARDANO_ACCOUNT_INDEX,
): Promise<T> {
  if (!config.blockfrostProjectId) throw new BlockfrostKeyMissingError();

  const { Lucid, Blockfrost } = await import('@lucid-evolution/lucid');
  const addresses = await deriveCardanoAddresses(mnemonic, config, accountIndex);

  let lucid: LucidEvolution;
  try {
    lucid = await Lucid(
      new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
      config.network,
    );
  } catch (err) {
    throw new NetworkError(
      `Could not reach Blockfrost at ${config.blockfrostUrl}. Check the URL and project id.`,
      err,
    );
  }

  // Must match the index the addresses above were derived at, or the session
  // would sign for one account while reporting another's address.
  lucid.selectWallet.fromSeed(mnemonic, {
    addressType: 'Base',
    accountIndex,
  });

  return fn({ lucid, addresses, config });
}
