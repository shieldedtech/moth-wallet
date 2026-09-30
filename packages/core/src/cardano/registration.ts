import type { UTxO } from '@lucid-evolution/lucid';
import { InvalidInputError, WalletError } from '../types/errors.js';
import {
  LOVELACE_FOR_REGISTRATION,
  MIN_LOVELACE_FOR_REGISTRATION,
  cnightGeneratesDustScript,
  dustAuthUnit,
  dustValidatorAddress,
  dustValidatorRewardAddress,
} from './blueprint.js';
import {
  buildDustMappingDatum,
  datumStakeKeyHash,
  decodeDustMappingDatum,
  encodeDustMappingDatum,
  encodeMintRedeemer,
  unitRedeemer,
} from './datum.js';
import { cnightUnit } from './network.js';
import type { CardanoSession } from './session.js';
import { decodeBech32mAddress } from '../wallet/address.js';

/** Indirection kept so this module's only ledger-WASM dependency is explicit. */
function requireAddressCodec(): { decodeBech32mAddress: typeof decodeBech32mAddress } {
  return { decodeBech32mAddress };
}

export type RegistrationStage =
  | 'collecting-utxos'
  | 'building'
  | 'signing'
  | 'submitting'
  | 'submitted';

export type StageReporter = (stage: RegistrationStage) => void;

export interface CardanoBalance {
  readonly lovelace: bigint;
  readonly cnight: bigint;
  /** Number of distinct UTXOs holding cNIGHT. All of them rotate on every write. */
  readonly cnightUtxoCount: number;
}

export interface RegistrationRecord {
  readonly utxo: UTxO;
  /** Midnight coin public key this Cardano stake key currently generates DUST to. */
  readonly coinPublicKey: string;
  readonly stakeKeyHash: string;
}

export class NoCnightError extends WalletError {
  constructor(action: string) {
    super(
      'WALLET_ERROR',
      `This Cardano address holds no cNIGHT, so there is nothing to ${action}.`,
    );
    this.name = 'NoCnightError';
  }
}

export class NotRegisteredError extends WalletError {
  constructor() {
    super('WALLET_ERROR', 'This Cardano stake key is not registered for DUST generation.');
    this.name = 'NotRegisteredError';
  }
}

export class AlreadyRegisteredError extends WalletError {
  constructor(coinPublicKey: string) {
    super(
      'WALLET_ERROR',
      `This Cardano stake key is already registered, generating DUST to ${coinPublicKey}.`,
    );
    this.name = 'AlreadyRegisteredError';
  }
}

/**
 * The Midnight coin public key the registration will generate DUST to: 32 raw
 * bytes, the same value the dApp reads out of a shielded address. It is NOT the
 * `mn_dust_...` DUST address, which encodes a different key entirely.
 */
export function assertCoinPublicKey(value: string): string {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new InvalidInputError(
      `Midnight coin public key must be 32 bytes of hex (64 characters), got ${hex.length} characters.`,
    );
  }
  return hex.toLowerCase();
}

/**
 * The Midnight coin public key encoded in a shielded (zswap) address.
 *
 * A shielded address is the coin public key followed by the encryption public
 * key, so the first 32 bytes are exactly what a Cardano registration datum
 * needs. Reading it from the public address means another account can be
 * offered as a DUST receiver without unlocking it — which is the whole point,
 * since the wallet holding the cNIGHT is rarely the one being paid.
 */
/**
 * Resolve whatever the user pasted into the coin public key a registration
 * datum takes.
 *
 * Accepts a shielded address or raw 32-byte hex. A DUST address is rejected
 * *by name*, because it is the most reasonable thing to paste into a field
 * about where DUST goes and it is the wrong value: `mn_dust_…` encodes a
 * 33-byte DUST public key, which is a different key from the 32-byte coin
 * public key the datum carries. Telling someone "enter 64 hex characters"
 * when they pasted a DUST address explains nothing.
 */
export function resolveDustReceiver(input: string): string {
  const text = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) return assertCoinPublicKey(text);
  if (text.startsWith('mn_')) {
    const { decodeBech32mAddress } = requireAddressCodec();
    let kind: string;
    try {
      kind = decodeBech32mAddress(text).type;
    } catch {
      throw new InvalidInputError('That is not a valid Midnight address.');
    }
    if (kind === 'shield-addr') return coinPublicKeyFromShieldedAddress(text);
    if (kind === 'dust') {
      throw new InvalidInputError(
        'That is a DUST address. Cardano registration records the shielded '
          + "address's coin public key instead — paste your mn_shield-addr… address.",
      );
    }
    throw new InvalidInputError(
      `That is a ${kind} address. Paste a shielded (mn_shield-addr…) address instead.`,
    );
  }
  throw new InvalidInputError(
    'Paste a Midnight shielded address (mn_shield-addr…) or a 64-character coin public key.',
  );
}

export function coinPublicKeyFromShieldedAddress(address: string): string {
  const { decodeBech32mAddress } = requireAddressCodec();
  const decoded = decodeBech32mAddress(address.trim());
  if (decoded.type !== 'shield-addr') {
    throw new InvalidInputError(
      `Expected a Midnight shielded address, got ${decoded.type}.`,
    );
  }
  if (decoded.data.length < 32) {
    throw new InvalidInputError('That shielded address is too short to contain a coin public key.');
  }
  return Array.from(decoded.data.slice(0, 32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function readCardanoBalance(session: CardanoSession): Promise<CardanoBalance> {
  const unit = cnightUnit(session.config);
  const utxos = await session.lucid.wallet().getUtxos();
  let lovelace = 0n;
  let cnight = 0n;
  let cnightUtxoCount = 0;
  for (const utxo of utxos) {
    lovelace += utxo.assets.lovelace ?? 0n;
    const held = utxo.assets[unit];
    if (held !== undefined) {
      cnight += held;
      cnightUtxoCount += 1;
    }
  }
  return { lovelace, cnight, cnightUtxoCount };
}

/**
 * Every cNIGHT UTXO in the wallet, which each of register/deregister/update
 * must spend.
 *
 * This is the part of the flow that is easy to get wrong. DUST accrues against
 * a cNIGHT UTXO from the moment it was created, and the ledger only re-reads a
 * UTXO's registration when that UTXO moves. Leaving one untouched leaves it
 * generating under the *old* mapping — after a deregistration, it keeps
 * producing DUST for an address the user just disowned. Spending them all
 * ("rotation") is what makes the change take effect everywhere at once.
 */
async function collectCnightUtxos(session: CardanoSession, action: string): Promise<UTxO[]> {
  const unit = cnightUnit(session.config);
  const utxos = await session.lucid.wallet().getUtxos();
  const cnight = utxos.filter((utxo) => utxo.assets[unit] !== undefined);
  if (cnight.length === 0) throw new NoCnightError(action);
  return cnight;
}

/**
 * Find this wallet's registration UTXO, if it has one.
 *
 * The auth NFT has an empty asset name, so its unit is bare policy id and every
 * registration on the network shares it — the lookup returns all of them and
 * the stake key hash in the datum is what narrows it to ours.
 */
export async function findRegistration(session: CardanoSession): Promise<RegistrationRecord | null> {
  const validatorAddress = await dustValidatorAddress(session.config);
  const candidates = await session.lucid.utxosAtWithUnit(validatorAddress, dustAuthUnit);
  for (const utxo of candidates) {
    if (!utxo.datum) continue;
    let decoded;
    try {
      decoded = decodeDustMappingDatum(utxo.datum);
    } catch {
      // Not every UTXO parked at this address has to be a registration datum.
      continue;
    }
    const stakeKeyHash = datumStakeKeyHash(decoded);
    if (stakeKeyHash !== session.addresses.stakeKeyHash) continue;
    return { utxo, coinPublicKey: decoded.dust_address, stakeKeyHash };
  }
  return null;
}

function assertEnoughAda(balance: CardanoBalance): void {
  if (balance.lovelace < MIN_LOVELACE_FOR_REGISTRATION) {
    throw new WalletError(
      'WALLET_ERROR',
      `Not enough ADA: ${balance.lovelace} lovelace held, about ${MIN_LOVELACE_FOR_REGISTRATION} needed ` +
        `(${LOVELACE_FOR_REGISTRATION} locked in the registration output, the rest for fees).`,
    );
  }
}

/**
 * Both signers are required by the validator. The payment key authorises
 * spending the wallet's UTXOs; the stake key is what proves the datum's
 * `c_wallet` really belongs to whoever is submitting, and without it anyone
 * could register DUST generation against someone else's stake credential.
 */
async function addSigners(
  builder: ReturnType<CardanoSession['lucid']['newTx']>,
  session: CardanoSession,
): Promise<void> {
  builder.addSigner(session.addresses.address);
  builder.addSigner(session.addresses.rewardAddress);
}

async function signAndSubmit(
  completed: { sign: { withWallet: () => { complete: () => Promise<{ submit: () => Promise<string> }> } } },
  onStage?: StageReporter,
): Promise<string> {
  onStage?.('signing');
  const signed = await completed.sign.withWallet().complete();
  onStage?.('submitting');
  const txHash = await signed.submit();
  onStage?.('submitted');
  return txHash;
}

/**
 * Register this Cardano stake key so its cNIGHT generates DUST to `coinPublicKey`.
 *
 * Mints the auth NFT and parks it at the mapping validator alongside an inline
 * datum, spending every cNIGHT UTXO on the way through.
 */
export async function registerForDust(
  session: CardanoSession,
  coinPublicKey: string,
  onStage?: StageReporter,
): Promise<string> {
  const coinPkHex = assertCoinPublicKey(coinPublicKey);

  onStage?.('collecting-utxos');
  const existing = await findRegistration(session);
  if (existing) throw new AlreadyRegisteredError(existing.coinPublicKey);

  const cnightUtxos = await collectCnightUtxos(session, 'register');
  assertEnoughAda(await readCardanoBalance(session));

  onStage?.('building');
  const validatorAddress = await dustValidatorAddress(session.config);
  const datum = encodeDustMappingDatum(
    buildDustMappingDatum(session.addresses.stakeKeyHash, coinPkHex),
  );

  const builder = session.lucid.newTx();
  builder.collectFrom(cnightUtxos);
  builder.mintAssets({ [dustAuthUnit]: 1n }, encodeMintRedeemer('Create'));
  builder.attach.MintingPolicy(cnightGeneratesDustScript);
  builder.pay.ToContract(
    validatorAddress,
    { kind: 'inline', value: datum },
    { lovelace: LOVELACE_FOR_REGISTRATION, [dustAuthUnit]: 1n },
  );
  await addSigners(builder, session);

  const completed = await builder.complete();
  return signAndSubmit(completed, onStage);
}

/**
 * Stop DUST generation: burn the auth NFT and consume the registration UTXO.
 *
 * Rotation matters most here. Burning alone leaves already-existing cNIGHT
 * UTXOs generating under the mapping that was just deleted, which is why every
 * cNIGHT UTXO is spent in the same transaction.
 */
export async function deregisterFromDust(
  session: CardanoSession,
  onStage?: StageReporter,
): Promise<string> {
  onStage?.('collecting-utxos');
  const registration = await findRegistration(session);
  if (!registration) throw new NotRegisteredError();
  const cnightUtxos = await collectCnightUtxos(session, 'deregister');

  onStage?.('building');
  const builder = session.lucid.newTx();
  builder.collectFrom(cnightUtxos);
  builder.mintAssets({ [dustAuthUnit]: -1n }, encodeMintRedeemer('Burn'));
  builder.attach.MintingPolicy(cnightGeneratesDustScript);
  builder.collectFrom([registration.utxo], unitRedeemer());
  builder.attach.SpendingValidator(cnightGeneratesDustScript);
  await addSigners(builder, session);

  const completed = await builder.complete();
  return signAndSubmit(completed, onStage);
}

/**
 * Point an existing registration at a different Midnight address.
 *
 * Spends the registration UTXO and recreates it with the same auth NFT and a
 * new datum — no mint, no burn, so the token count is untouched. The validator
 * will not authorise that from the spending path alone, hence the zero-value
 * withdrawal from its own reward address: it exists purely to make the
 * withdrawal validator run and approve the swap.
 */
export async function updateDustAddress(
  session: CardanoSession,
  newCoinPublicKey: string,
  onStage?: StageReporter,
): Promise<string> {
  const coinPkHex = assertCoinPublicKey(newCoinPublicKey);

  onStage?.('collecting-utxos');
  const registration = await findRegistration(session);
  if (!registration) throw new NotRegisteredError();
  if (registration.coinPublicKey === coinPkHex) {
    throw new InvalidInputError('That is already the registered DUST address.');
  }
  const cnightUtxos = await collectCnightUtxos(session, 'update');

  onStage?.('building');
  const validatorAddress = await dustValidatorAddress(session.config);
  const validatorRewardAddress = await dustValidatorRewardAddress(session.config);
  const datum = encodeDustMappingDatum(
    buildDustMappingDatum(session.addresses.stakeKeyHash, coinPkHex),
  );

  const builder = session.lucid.newTx();
  builder.collectFrom(cnightUtxos);
  builder.collectFrom([registration.utxo], unitRedeemer());
  builder.attach.SpendingValidator(cnightGeneratesDustScript);
  builder.pay.ToContract(
    validatorAddress,
    { kind: 'inline', value: datum },
    { lovelace: LOVELACE_FOR_REGISTRATION, [dustAuthUnit]: 1n },
  );
  builder.withdraw(validatorRewardAddress, 0n, unitRedeemer());
  builder.attach.WithdrawalValidator(cnightGeneratesDustScript);
  await addSigners(builder, session);

  const completed = await builder.complete();
  return signAndSubmit(completed, onStage);
}
