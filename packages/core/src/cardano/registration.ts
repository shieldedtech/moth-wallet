import type { UTxO } from '@lucid-evolution/lucid';
import { InvalidInputError, WalletError } from '../types/errors.js';
import {
  LOVELACE_FOR_REGISTRATION,
  MIN_LOVELACE_FOR_REGISTRATION,
  cnightGeneratesDustScript,
  dustAuthUnit,
  dustValidatorAddress,
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
import { DustAddress, MidnightBech32m } from '@midnightntwrk/wallet-sdk/address-format';

/** Indirection kept so this module's only WASM dependency is explicit. */
function requireAddressCodec() {
  return { MidnightBech32m, DustAddress };
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
  /** Serialized DUST address this Cardano stake key currently generates DUST to. */
  readonly dustAddress: string;
  readonly stakeKeyHash: string;
  /**
   * True when `dustAddress` is not a 33-byte serialized DUST address — in
   * practice, a registration written against the 32-byte shielded coin public
   * key. The validator accepts anything up to 33 bytes, so this is valid on
   * Cardano and useless on Midnight: the bridge never matches it and DUST
   * never arrives, with nothing anywhere reporting an error. Surfaced so the
   * UI can say so instead of showing a healthy-looking registration.
   */
  readonly legacyDustAddress: boolean;
}

/** A serialized DUST address is 33 bytes; anything else the bridge cannot match. */
const DUST_ADDRESS_HEX_LENGTH = 66;

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
  constructor(dustAddress: string) {
    super(
      'WALLET_ERROR',
      `This Cardano stake key is already registered, generating DUST to ${dustAddress}.`,
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
 * Serialized bytes of a Midnight DUST address — what a registration datum
 * records, 33 bytes.
 *
 * Not the shielded coin public key, which is 32 bytes and a different key
 * entirely. Both decode cleanly from their own address type, so nothing
 * downstream catches the swap: the registration is valid on Cardano and the
 * bridge simply never matches it.
 */
export function dustAddressBytes(address: string): string {
  const { MidnightBech32m, DustAddress } = requireAddressCodec();
  const text = address.trim();
  let parsed;
  try {
    parsed = MidnightBech32m.parse(text);
  } catch {
    throw new InvalidInputError('That is not a valid Midnight address.');
  }
  if (parsed.type !== 'dust') {
    throw new InvalidInputError(
      `That is a ${parsed.type} address. A cNIGHT registration records a DUST `
        + 'address — paste your mn_dust_… address.',
    );
  }
  // Decoded against the address's own network: the payload is network-agnostic,
  // but parsing has to agree with the prefix it was written with.
  const decoded = parsed.decode(DustAddress, parsed.network);
  // The whole 33 bytes serialize() returns — a 0x73 type tag then the payload.
  // Every live registration at the deployed contract carries the tagged form
  // (CBOR header 5821, leading 0x73), and its datum bound is `<= 33`.
  return Buffer.from(decoded.serialize()).toString('hex').toLowerCase();
}

/** A serialized DUST address is 33 bytes; reject anything else before a datum. */
export function assertDustAddressBytes(value: string): string {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{66}$/.test(hex)) {
    throw new InvalidInputError(
      `A DUST address is 33 bytes of hex (66 characters), got ${hex.length} characters.`,
    );
  }
  return hex.toLowerCase();
}

/**
 * Turn whatever the user pasted into the bytes a registration datum takes.
 *
 * Accepts an `mn_dust_…` address or its raw 33-byte hex. A *shielded* address
 * is rejected by name: it is the other plausible thing to paste, it is what an
 * earlier version of the dApp used, and its coin public key is the wrong value.
 */
export function resolveDustReceiver(input: string): string {
  const text = input.trim();
  if (/^(0x)?[0-9a-fA-F]{66}$/.test(text)) return assertDustAddressBytes(text);
  if (text.startsWith('mn_')) return dustAddressBytes(text);
  throw new InvalidInputError(
    'Paste a Midnight DUST address (mn_dust_…) or its 66-character hex.',
  );
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
export async function findRegistrations(session: CardanoSession): Promise<RegistrationRecord[]> {
  const validatorAddress = await dustValidatorAddress(session.config);
  const candidates = await session.lucid.utxosAtWithUnit(validatorAddress, dustAuthUnit);
  const found: RegistrationRecord[] = [];
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
    found.push({
      utxo,
      dustAddress: decoded.dust_address,
      stakeKeyHash,
      legacyDustAddress: decoded.dust_address.length !== DUST_ADDRESS_HEX_LENGTH,
    });
  }
  return found;
}

/**
 * This wallet's registration, or null.
 *
 * Returns the first of several if the stake key somehow has more than one —
 * callers that care use `findRegistrations`. More than one is a broken state,
 * not a richer one: a second registration against the same stake key forces
 * DEREGISTRATION, so the wallet must never create one and should say so when
 * it finds one.
 */
export async function findRegistration(session: CardanoSession): Promise<RegistrationRecord | null> {
  return (await findRegistrations(session))[0] ?? null;
}

export class MultipleRegistrationsError extends WalletError {
  constructor(count: number) {
    super(
      'WALLET_ERROR',
      `This Cardano stake key has ${count} registrations. More than one forces `
        + 'deregistration, so nothing is generating. Deregister to clear them, then register once.',
    );
    this.name = 'MultipleRegistrationsError';
  }
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
 * Complete a script transaction.
 *
 * Evaluation stays local. Asking the provider instead (`localUPLCEval: false`)
 * would give us the validator's own traces, which the local evaluator throws
 * away — it reports only "the validator crashed / exited prematurely" — but
 * lucid's Blockfrost evaluation is broken: ogmios rejects the request with
 * "failed to decode payload from base64 or base16" before any script runs, so
 * the transaction cannot be built at all. Local evaluation is opaque; remote
 * evaluation does not work. Opaque wins.
 *
 * The one thing remote evaluation did give us is the full transaction CBOR in
 * the error message, which is how the datum, mint and signers above were
 * verified by hand.
 */
async function completeWithProviderEval(
  builder: ReturnType<CardanoSession['lucid']['newTx']>,
) {
  return builder.complete();
}

/**
 * Register this Cardano stake key so its cNIGHT generates DUST to `dustAddress`.
 *
 * Mints the auth NFT and parks it at the mapping validator alongside an inline
 * datum, spending every cNIGHT UTXO on the way through.
 */
export async function registerForDust(
  session: CardanoSession,
  dustAddress: string,
  onStage?: StageReporter,
): Promise<string> {
  const dustHex = resolveDustReceiver(dustAddress);

  onStage?.('collecting-utxos');
  // Checked against ALL registrations, not just the first. A second
  // registration on one stake key forces deregistration — the wallet creating
  // that state would be worse than refusing.
  const existing = await findRegistrations(session);
  if (existing.length > 1) throw new MultipleRegistrationsError(existing.length);
  if (existing.length === 1) throw new AlreadyRegisteredError(existing[0]!.dustAddress);

  const cnightUtxos = await collectCnightUtxos(session, 'register');
  assertEnoughAda(await readCardanoBalance(session));

  onStage?.('building');
  const validatorAddress = await dustValidatorAddress(session.config);
  const datum = encodeDustMappingDatum(
    buildDustMappingDatum(session.addresses.stakeKeyHash, dustHex),
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

  const completed = await completeWithProviderEval(builder);
  return signAndSubmit(completed, onStage);
}

/**
 * Stop DUST generation: burn the auth NFT and consume the registration UTXO.
 *
 * Rotation matters most here. Burning alone leaves already-existing cNIGHT
 * UTXOs generating under the mapping that was just deleted, which is why every
 * cNIGHT UTXO is spent in the same transaction.
 */
export interface DeregisterResult {
  readonly txHash: string;
  /** How many registrations this transaction cleared. */
  readonly cleared: number;
}

/**
 * Stop DUST generation: burn every auth NFT this stake key holds and consume
 * every registration UTXO, in one transaction.
 *
 * ALL of them, not the first. A stake key with more than one registration is
 * not generating — a second registration forces deregistration — and clearing
 * one at a time would leave the wallet in a state whose meaning depends on
 * rules we do not control. One transaction ends with zero, which is
 * unambiguous under any reading, and is the state `register` can build on.
 *
 * Rotation matters as much as the burn. Already-existing cNIGHT UTXOs keep
 * generating under the mapping that was just deleted until they move, which is
 * why every cNIGHT UTXO is spent in the same transaction.
 */
export async function deregisterFromDust(
  session: CardanoSession,
  onStage?: StageReporter,
): Promise<DeregisterResult> {
  onStage?.('collecting-utxos');
  const registrations = await findRegistrations(session);
  if (registrations.length === 0) throw new NotRegisteredError();
  const cnightUtxos = await collectCnightUtxos(session, 'deregister');

  onStage?.('building');
  const builder = session.lucid.newTx();
  builder.collectFrom(cnightUtxos);
  // One NFT per registration UTXO, so the burn has to match the count or the
  // transaction does not balance.
  builder.mintAssets(
    { [dustAuthUnit]: -BigInt(registrations.length) },
    encodeMintRedeemer('Burn'),
  );
  builder.attach.MintingPolicy(cnightGeneratesDustScript);
  builder.collectFrom(registrations.map((r) => r.utxo), unitRedeemer());
  builder.attach.SpendingValidator(cnightGeneratesDustScript);
  await addSigners(builder, session);

  const completed = await completeWithProviderEval(builder);
  return { txHash: await signAndSubmit(completed, onStage), cleared: registrations.length };
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
  newDustAddress: string,
  onStage?: StageReporter,
): Promise<string> {
  const dustHex = resolveDustReceiver(newDustAddress);

  onStage?.('collecting-utxos');
  const registration = await findRegistration(session);
  if (!registration) throw new NotRegisteredError();
  if (registration.dustAddress === dustHex) {
    throw new InvalidInputError('That is already the registered DUST address.');
  }
  const cnightUtxos = await collectCnightUtxos(session, 'update');

  onStage?.('building');
  const validatorAddress = await dustValidatorAddress(session.config);
  const datum = encodeDustMappingDatum(
    buildDustMappingDatum(session.addresses.stakeKeyHash, dustHex),
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
  // Deliberately NO withdrawal. The spend validator authorises through
  // `check_auth(c_wallet, extra_signatories, withdrawals)`, which is an
  // either/or: a VerificationKey credential — what every moth account has —
  // is satisfied by signing with the stake key, and only a Script credential
  // needs the withdrawal route. Adding one anyway invokes the withdrawal
  // validator, a separate entry point whose redeemer is an OutputReference it
  // uses to find an input. Handing it the unit redeemer made it destructure an
  // empty constructor and abort: "Withdraw[0] the validator crashed".
  await addSigners(builder, session);

  const completed = await completeWithProviderEval(builder);
  return signAndSubmit(completed, onStage);
}
