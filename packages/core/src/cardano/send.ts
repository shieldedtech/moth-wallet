import { InvalidInputError, WalletError } from '../types/errors.js';
import { cnightUnit } from './network.js';
import { readCardanoBalance, type StageReporter } from './registration.js';
import type { CardanoSession } from './session.js';

/** Lovelace per ADA. */
export const LOVELACE_PER_ADA = 1_000_000n;

/**
 * STARs per cNIGHT: 6 decimal places, the same as NIGHT on Midnight.
 *
 * The on-chain quantity is in STARs, and Cardano carries no protocol-level
 * decimals — the asset publishes no token-registry entry either, which is why
 * block explorers show the raw integer. Nothing on chain will tell you this
 * scale, so it lives here: the dApp applies exactly the same factor when it
 * renders a cNIGHT balance and when it computes DUST capacity.
 */
export const STARS_PER_CNIGHT = 1_000_000n;

/**
 * Floor on any output: the protocol rejects an output holding less, and a
 * "send 0.1 ADA" that fails deep in the node is worse than one refused here.
 * The true minimum depends on the output's size, so this is the plain-ADA case
 * and Lucid still has the final say for outputs carrying tokens.
 */
export const MIN_ADA_OUTPUT = 1_000_000n;

export interface CardanoSendRequest {
  readonly to: string;
  readonly lovelace?: bigint;
  readonly cnight?: bigint;
}

export class CardanoSendError extends WalletError {
  constructor(message: string) {
    super('WALLET_ERROR', message);
    this.name = 'CardanoSendError';
  }
}

/** ADA as a decimal string → lovelace. Rejects more than 6 decimal places. */
export function parseAda(value: string): bigint {
  return parseFixed6(value, LOVELACE_PER_ADA, 'ADA');
}

export function formatAda(lovelace: bigint): string {
  return formatFixed6(lovelace, LOVELACE_PER_ADA);
}

/** cNIGHT for display: STARs → whole cNIGHT, trailing zeros trimmed. */
export function formatCnight(stars: bigint): string {
  return formatFixed6(stars, STARS_PER_CNIGHT);
}

/**
 * cNIGHT as typed → STARs. Accepts the same shape as an ADA amount.
 *
 * Without this a user asking to send "10" moves 10 STARs — a ten-thousandth of
 * a cNIGHT — and the transaction succeeds, which is the worst way to find out.
 */
export function parseCnight(value: string): bigint {
  return parseFixed6(value, STARS_PER_CNIGHT, 'cNIGHT');
}

function formatFixed6(raw: bigint, unit: bigint): string {
  const whole = raw / unit;
  const frac = (raw % unit).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function parseFixed6(value: string, unit: bigint, label: string): bigint {
  const text = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new InvalidInputError(
      `Invalid ${label} amount "${value}". Use a decimal with at most 6 places, e.g. 1.5`,
    );
  }
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole!) * unit + BigInt(frac.padEnd(6, '0'));
}

/**
 * Check the destination is a Cardano address on the session's own network.
 *
 * Bech32 catches typos by itself, but not the mistake that actually costs
 * money: a mainnet address entered while on a testnet, or the reverse. Those
 * are well-formed and would be accepted by the builder, so the network id is
 * compared explicitly.
 */
export async function assertSendableAddress(
  session: CardanoSession,
  to: string,
): Promise<void> {
  const { getAddressDetails } = await import('@lucid-evolution/lucid');
  let details;
  try {
    details = getAddressDetails(to.trim());
  } catch {
    throw new InvalidInputError(`"${to}" is not a valid Cardano address.`);
  }
  if (details.networkId !== session.config.networkId) {
    const target = details.networkId === 1 ? 'mainnet' : 'a testnet';
    throw new InvalidInputError(
      `That address is for ${target}, but this wallet is on ${session.config.network}. `
        + 'Sending would burn the funds — check the address.',
    );
  }
}

/**
 * Send ADA and/or cNIGHT to another Cardano address.
 *
 * Note what this does NOT do: it never touches the registration UTXO at the
 * mapping validator, because that lives at the validator's address and not in
 * this wallet. It can still change DUST generation, though — cNIGHT that
 * leaves stops generating, and the UTXOs this spends are rotated, which is why
 * callers are expected to say so before confirming.
 */
export async function sendCardanoAssets(
  session: CardanoSession,
  request: CardanoSendRequest,
  onStage?: StageReporter,
): Promise<string> {
  const to = request.to.trim();
  const lovelace = request.lovelace ?? 0n;
  const cnight = request.cnight ?? 0n;

  // Negatives first: a negative amount also satisfies the "nothing to send"
  // test below, and reporting it that way hides what is actually wrong.
  if (lovelace < 0n || cnight < 0n) {
    throw new InvalidInputError('Amounts cannot be negative.');
  }
  if (lovelace === 0n && cnight === 0n) {
    throw new InvalidInputError('Nothing to send — specify an ADA amount, a cNIGHT amount, or both.');
  }
  await assertSendableAddress(session, to);

  onStage?.('collecting-utxos');
  const balance = await readCardanoBalance(session);
  if (cnight > balance.cnight) {
    throw new CardanoSendError(
      `Not enough cNIGHT: ${formatCnight(balance.cnight)} held, ${formatCnight(cnight)} requested.`,
    );
  }
  // Fees come out of the same balance, so an exact-balance ADA send cannot
  // work. Refusing here names the reason; letting the builder fail says only
  // that coin selection did not converge.
  if (lovelace > 0n && lovelace >= balance.lovelace) {
    throw new CardanoSendError(
      `Not enough ADA: ${formatAda(balance.lovelace)} held, ${formatAda(lovelace)} requested, `
        + 'and the transaction fee comes out of the same balance.',
    );
  }

  const assets: Record<string, bigint> = {};
  // An output carrying a token still needs ADA alongside it. When the caller
  // asked only for cNIGHT, the minimum is added rather than refusing — the
  // alternative is a confusing error about an amount the user never mentioned.
  assets.lovelace = lovelace > 0n ? lovelace : MIN_ADA_OUTPUT;
  if (cnight > 0n) assets[cnightUnit(session.config)] = cnight;

  onStage?.('building');
  const builder = session.lucid.newTx();
  builder.pay.ToAddress(to, assets);
  const completed = await builder.complete();

  onStage?.('signing');
  const signed = await completed.sign.withWallet().complete();
  onStage?.('submitting');
  const txHash = await signed.submit();
  onStage?.('submitted');
  return txHash;
}
