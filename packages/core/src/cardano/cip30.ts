// CIP-30 (Cardano dApp-Wallet Web Bridge) data layer.
//
// Everything a CIP-30 API method needs to answer, expressed over a
// CardanoSession. The transport — injection, origin permissions, approval
// prompts — belongs to whichever surface exposes it; this file only knows how
// to produce the values CIP-30 specifies, in the encodings it specifies.
//
// CIP-30 speaks hex-encoded CBOR almost everywhere, which is why so little of
// this returns a typed value: the boundary is bytes, and converting early
// keeps the conversion in one place instead of at every call site.

import { InvalidInputError } from '../types/errors.js';
import type { CardanoSession } from './session.js';

/**
 * CIP-30 APIError codes. Numeric because the spec fixes them, and dApps switch
 * on the number rather than the message.
 */
export const CIP30_ERROR = {
  InvalidRequest: -1,
  InternalError: -2,
  Refused: -3,
  AccountChange: -4,
} as const;

/** CIP-30 TxSendError codes. */
export const CIP30_TX_SEND_ERROR = { Refused: 1, Failure: 2 } as const;

/** CIP-30 TxSignError codes. */
export const CIP30_TX_SIGN_ERROR = { ProofGeneration: 1, UserDeclined: 2 } as const;

/** CIP-30 DataSignError codes. */
export const CIP30_DATA_SIGN_ERROR = {
  ProofGeneration: 1,
  AddressNotPK: 2,
  UserDeclined: 3,
} as const;

/** The shape CIP-30 requires a rejected call to throw. */
export interface Cip30Error {
  readonly code: number;
  readonly info: string;
}

export function cip30Error(code: number, info: string): Cip30Error {
  return { code, info };
}

/**
 * CIP-30 `PaginateError`, which is NOT an APIError: it carries `maxSize` and
 * no numeric code at all. dApps read `maxSize` to re-issue a request that fits,
 * so sending them `{ code, info }` leaves them with nothing to correct.
 * `maxSize` is the number of items available, not the last page index.
 */
export interface Cip30PaginateError {
  readonly maxSize: number;
}

export function cip30PaginateError(maxSize: number): Cip30PaginateError {
  return { maxSize };
}

export interface Cip30Paginate {
  readonly page: number;
  readonly limit: number;
}

/**
 * Apply CIP-30 pagination.
 *
 * A page starting past the end is `PaginateError`, not an empty list — the
 * spec makes that distinction so a dApp can tell "no more" from "nothing
 * here", and returning [] for both makes an off-by-one silent. Page 0 is never
 * out of range: an empty wallet answering page 0 has genuinely nothing, which
 * is an answer rather than a mistake.
 */
export function paginate<T>(items: readonly T[], p?: Cip30Paginate): readonly T[] {
  if (!p) return items;
  const start = p.page * p.limit;
  if (start > 0 && start >= items.length) throw cip30PaginateError(items.length);
  return items.slice(start, start + p.limit);
}

/**
 * The CIP extensions moth implements, for `getExtensions`.
 *
 * Empty, and deliberately so: it must agree with the `supportedExtensions`
 * advertised before `enable`, and claiming a CIP moth does not implement is
 * worse than claiming none — a dApp would call into it and get nothing back.
 */
export function getExtensions(): { readonly cip: number }[] {
  return [];
}

/**
 * Decode a CIP-30 `cbor<Value>` (or `cbor<Coin>`, which is just a bare uint)
 * into an asset map.
 *
 * Strictly CBOR, with no decimal-string fallback, because the two are not
 * distinguishable: "10000000" is valid CBOR for the integer **16**. Guessing
 * would let a dApp that sends a decimal string quietly receive collateral
 * three orders of magnitude too small rather than an error it can act on.
 */
export async function valueFromCbor(cborHex: string): Promise<Record<string, bigint>> {
  const { CML, valueToAssets } = await import('@lucid-evolution/lucid');
  try {
    return valueToAssets(CML.Value.from_cbor_hex(cborHex));
  } catch {
    throw cip30Error(CIP30_ERROR.InvalidRequest, 'amount is not valid CBOR');
  }
}

/** Does `held` cover every asset in `required`? */
function covers(held: Record<string, bigint>, required: Record<string, bigint>): boolean {
  return Object.entries(required).every(([unit, need]) => (held[unit] ?? 0n) >= need);
}

/** 1 for mainnet, 0 for every testnet — CIP-30's `getNetworkId`. */
export function getNetworkId(session: CardanoSession): number {
  return session.config.networkId;
}

/** Bech32 address → the hex encoding CIP-30 passes addresses in. */
export async function addressToHex(address: string): Promise<string> {
  const { CML } = await import('@lucid-evolution/lucid');
  return CML.Address.from_bech32(address).to_hex();
}

/**
 * Every address this wallet uses.
 *
 * One, deliberately. moth derives a single base address per Cardano account
 * (CIP-1852 role 0, index 0) rather than scanning a gap limit, so "used" and
 * "unused" are the same address and there is nothing to paginate. A dApp
 * treating the list as exhaustive is therefore correct, which is the property
 * that matters.
 */
export async function getUsedAddresses(
  session: CardanoSession,
  p?: Cip30Paginate,
): Promise<string[]> {
  return [...paginate([await addressToHex(session.addresses.address)], p)];
}

/**
 * CIP-30 wants addresses never yet seen on chain. moth has no unused address
 * to offer — see getUsedAddresses — and an empty list is the honest answer.
 */
export function getUnusedAddresses(): string[] {
  return [];
}

export async function getChangeAddress(session: CardanoSession): Promise<string> {
  return addressToHex(session.addresses.address);
}

export async function getRewardAddresses(session: CardanoSession): Promise<string[]> {
  return [await addressToHex(session.addresses.rewardAddress)];
}

/** Total balance as a CBOR-encoded Value. */
export async function getBalance(session: CardanoSession): Promise<string> {
  const { assetsToValue } = await import('@lucid-evolution/lucid');
  const utxos = await session.lucid.wallet().getUtxos();
  const total: Record<string, bigint> = {};
  for (const utxo of utxos) {
    for (const [unit, quantity] of Object.entries(utxo.assets)) {
      total[unit] = (total[unit] ?? 0n) + quantity;
    }
  }
  if (total.lovelace === undefined) total.lovelace = 0n;
  return assetsToValue(total).to_cbor_hex();
}

/**
 * UTXOs as CBOR TransactionUnspentOutput.
 *
 * The argument order is CIP-30's: `amount` first, `paginate` second. Getting
 * that backwards is not a type error at the bridge — both arrive as unknowns —
 * so a dApp asking for page 2 would silently be handed page 0 forever.
 *
 * `amount` asks for a subset covering at least that Value rather than the whole
 * wallet. Largest-first, so the smallest number of inputs satisfies it; null
 * when the wallet cannot cover it, which is what tells a dApp to stop waiting.
 */
export async function getUtxos(
  session: CardanoSession,
  amountCborHex?: string,
  p?: Cip30Paginate,
): Promise<string[] | null> {
  const { utxoToCore } = await import('@lucid-evolution/lucid');
  const utxos = await session.lucid.wallet().getUtxos();
  // CIP-30: null, not [], when the wallet holds nothing. dApps branch on it.
  if (utxos.length === 0) return null;

  let selected = utxos;
  if (amountCborHex) {
    const required = await valueFromCbor(amountCborHex);
    const sorted = [...utxos].sort((a, b) =>
      (b.assets.lovelace ?? 0n) > (a.assets.lovelace ?? 0n) ? 1 : -1,
    );
    const picked: typeof utxos = [];
    const running: Record<string, bigint> = {};
    for (const utxo of sorted) {
      if (covers(running, required)) break;
      picked.push(utxo);
      for (const [unit, qty] of Object.entries(utxo.assets)) {
        running[unit] = (running[unit] ?? 0n) + qty;
      }
    }
    if (!covers(running, required)) return null;
    selected = picked;
  }

  return paginate(selected, p).map((u) => utxoToCore(u).to_cbor_hex());
}

/**
 * UTXOs usable as Plutus collateral: pure ADA, no tokens.
 *
 * A UTXO carrying native assets cannot be collateral — the ledger requires the
 * collateral return to be pure ADA — so filtering here is the difference
 * between a dApp getting a usable answer and getting a transaction the node
 * rejects.
 */
export async function getCollateral(
  session: CardanoSession,
  params?: { readonly amount?: string },
): Promise<string[] | null> {
  const { utxoToCore } = await import('@lucid-evolution/lucid');
  // CIP-30 passes `{ amount: cbor<Coin> }`, not a bigint. Five ADA is the
  // ceiling the ledger allows for collateral and what dApps assume when they
  // ask for none, so it is the right default rather than an arbitrary one.
  const requestedLovelace = params?.amount
    ? ((await valueFromCbor(params.amount)).lovelace ?? 0n)
    : 5_000_000n;
  const utxos = await session.lucid.wallet().getUtxos();
  const pureAda = utxos
    .filter((u) => Object.keys(u.assets).length === 1 && u.assets.lovelace !== undefined)
    .sort((a, b) => (a.assets.lovelace! > b.assets.lovelace! ? 1 : -1));

  const picked = [];
  let total = 0n;
  for (const utxo of pureAda) {
    if (total >= requestedLovelace) break;
    picked.push(utxo);
    total += utxo.assets.lovelace!;
  }
  if (total < requestedLovelace) return null;
  return picked.map((u) => utxoToCore(u).to_cbor_hex());
}

/**
 * Sign a transaction, returning only the witness set.
 *
 * CIP-30 returns witnesses rather than a signed transaction so the dApp keeps
 * control of assembly. `partialSign` is accepted and ignored: moth holds one
 * key set and signs with all of it either way, and refusing the flag outright
 * would break dApps that pass it harmlessly.
 */
export async function signTx(session: CardanoSession, txCborHex: string): Promise<string> {
  const { CML } = await import('@lucid-evolution/lucid');
  let tx;
  try {
    tx = CML.Transaction.from_cbor_hex(txCborHex);
  } catch {
    throw cip30Error(CIP30_ERROR.InvalidRequest, 'transaction is not valid CBOR');
  }
  const witnesses = await session.lucid.wallet().signTx(tx);
  return witnesses.to_cbor_hex();
}

/** CIP-30 DataSignature: a COSE_Sign1 signature plus the COSE_Key. */
export interface Cip30DataSignature {
  readonly signature: string;
  readonly key: string;
}

/**
 * Sign arbitrary bytes (CIP-8) for one of this wallet's addresses.
 *
 * The address is checked rather than trusted: CIP-30 requires
 * `AddressNotPK` for an address the wallet cannot sign for, and signing with
 * whatever key we happen to hold would answer a different question than the
 * one asked.
 */
export async function signData(
  session: CardanoSession,
  addressHexOrBech32: string,
  payloadHex: string,
): Promise<Cip30DataSignature> {
  const { CML } = await import('@lucid-evolution/lucid');
  let bech32: string;
  try {
    bech32 = addressHexOrBech32.startsWith('addr') || addressHexOrBech32.startsWith('stake')
      ? addressHexOrBech32
      : CML.Address.from_hex(addressHexOrBech32).to_bech32(undefined);
  } catch {
    throw cip30Error(CIP30_DATA_SIGN_ERROR.AddressNotPK, 'address is not valid');
  }
  if (bech32 !== session.addresses.address && bech32 !== session.addresses.rewardAddress) {
    throw cip30Error(
      CIP30_DATA_SIGN_ERROR.AddressNotPK,
      'this wallet cannot sign for that address',
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(payloadHex)) {
    throw new InvalidInputError('payload must be hex');
  }
  return session.lucid.wallet().signMessage(bech32, payloadHex);
}

/** Submit a fully assembled transaction; returns its hash. */
export async function submitTx(session: CardanoSession, txCborHex: string): Promise<string> {
  try {
    return await session.lucid.wallet().submitTx(txCborHex);
  } catch (err) {
    throw cip30Error(
      CIP30_TX_SEND_ERROR.Failure,
      err instanceof Error ? err.message : String(err),
    );
  }
}
