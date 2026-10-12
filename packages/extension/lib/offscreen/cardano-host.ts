// Cardano / cNIGHT operations, hosted in the offscreen document.
//
// They live here and not in the service worker for the same reason the wallet
// does: Lucid loads the Cardano multiplatform library's WASM, and the offscreen
// document is the context in this extension that is set up to run it. Every
// import of the Cardano module below is dynamic so that a session which never
// opens the Cardano screen never pays for the WASM.

import type { CardanoNetworkConfig } from '@shieldedtech/moth-wallet/cardano/network';
import type { CardanoSession } from '@shieldedtech/moth-wallet/cardano/session';
import type { Cip30Result } from './messaging';

export interface CardanoAddressesResult {
  cardanoNetwork: string;
  address: string;
  rewardAddress: string;
  stakeKeyHash: string;
  paymentKeyHash: string;
}

export interface CardanoStatusResult extends CardanoAddressesResult {
  /** Decimal strings: both exceed Number's safe integer range. */
  lovelace: string;
  cnight: string;
  cnightUtxos: number;
  registered: boolean;
  registeredDustAddress: string | null;
  registrationUtxo: string | null;
  generationRate: string | null;
  /**
   * DUST accrued so far and the ceiling it accrues toward, both in SPECK
   * (10^15 per DUST) as decimal strings. Null until the indexer reports them.
   */
  currentCapacity: string | null;
  maxCapacity: string | null;
  /** Unix seconds Midnight is expected to act on the registration; null if unknown. */
  generatingFrom: number | null;
  secondsRemaining: number | null;
  /** null = Midnight has no record; false = ingested and rejected; true = live. */
  midnightValid: boolean | null;
  /** >1 forces deregistration, so it is a fault to surface. */
  registrationCount: number;
  /**
   * The registration records something that is not a 33-byte DUST address, so
   * it can never generate DUST. `update` rewrites it in one transaction.
   */
  legacyDustAddress: boolean;
}

async function openSession<T>(
  mnemonic: string,
  config: CardanoNetworkConfig,
  fn: (session: CardanoSession) => Promise<T>,
  accountIndex?: number,
): Promise<T> {
  const { withCardanoSession } = await import('@shieldedtech/moth-wallet/cardano');
  return withCardanoSession(mnemonic, config, fn, accountIndex);
}

/** Pure derivation — no Blockfrost project id required. */
export async function cardanoAddresses(
  mnemonic: string,
  config: CardanoNetworkConfig,
  accountIndex?: number,
): Promise<CardanoAddressesResult> {
  const { deriveCardanoAddresses } = await import('@shieldedtech/moth-wallet/cardano');
  const addresses = await deriveCardanoAddresses(mnemonic, config, accountIndex);
  return { cardanoNetwork: config.network, ...addresses };
}

export async function cardanoStatus(
  mnemonic: string,
  config: CardanoNetworkConfig,
  indexerUrl: string,
  accountIndex?: number,
): Promise<CardanoStatusResult> {
  const { readCardanoDustStatus } = await import('@shieldedtech/moth-wallet/cardano');
  return openSession(mnemonic, config, async (session) => {
    const status = await readCardanoDustStatus(session, indexerUrl);
    return {
      cardanoNetwork: status.network,
      address: status.addresses.address,
      rewardAddress: status.addresses.rewardAddress,
      stakeKeyHash: status.addresses.stakeKeyHash,
      paymentKeyHash: status.addresses.paymentKeyHash,
      lovelace: status.balance.lovelace.toString(),
      cnight: status.balance.cnight.toString(),
      cnightUtxos: status.balance.cnightUtxoCount,
      registered: status.registered,
      registeredDustAddress: status.dustAddress,
      registrationUtxo: status.registrationUtxo
        ? `${status.registrationUtxo.txHash}#${status.registrationUtxo.outputIndex}`
        : null,
      generationRate: status.generation?.generationRate ?? null,
      currentCapacity: status.generation?.currentCapacity ?? null,
      maxCapacity: status.generation?.maxCapacity ?? null,
      generatingFrom: status.finality?.generatingFrom ?? null,
      secondsRemaining: status.finality?.secondsRemaining ?? null,
      midnightValid: status.midnightRegistration?.valid ?? null,
      registrationCount: status.registrationCount,
      legacyDustAddress: status.legacyDustAddress,
    };
  }, accountIndex);
}

export async function cardanoRegister(
  mnemonic: string,
  config: CardanoNetworkConfig,
  receiver: string,
  accountIndex?: number,
): Promise<{ txHash: string }> {
  const { registerForDust } = await import('@shieldedtech/moth-wallet/cardano');
  return openSession(mnemonic, config, async (session) => ({
    txHash: await registerForDust(session, receiver),
  }), accountIndex);
}

export async function cardanoDeregister(
  mnemonic: string,
  config: CardanoNetworkConfig,
  accountIndex?: number,
): Promise<{ txHash: string; cleared: number }> {
  const { deregisterFromDust } = await import('@shieldedtech/moth-wallet/cardano');
  return openSession(mnemonic, config, (session) => deregisterFromDust(session), accountIndex);
}

export async function cardanoUpdate(
  mnemonic: string,
  config: CardanoNetworkConfig,
  receiver: string,
  accountIndex?: number,
): Promise<{ txHash: string }> {
  const { updateDustAddress } = await import('@shieldedtech/moth-wallet/cardano');
  return openSession(mnemonic, config, async (session) => ({
    txHash: await updateDustAddress(session, receiver),
  }), accountIndex);
}

export async function cardanoSend(
  mnemonic: string,
  config: CardanoNetworkConfig,
  request: { to: string; lovelace: string; cnight: string },
  accountIndex?: number,
): Promise<{ txHash: string }> {
  const { sendCardanoAssets } = await import('@shieldedtech/moth-wallet/cardano');
  // Amounts cross the message boundary as decimal strings: structured cloning
  // would carry a bigint, but the extension's protocol is JSON end to end.
  return openSession(mnemonic, config, async (session) => ({
    txHash: await sendCardanoAssets(session, {
      to: request.to,
      lovelace: BigInt(request.lovelace),
      cnight: BigInt(request.cnight),
    }),
  }), accountIndex);
}


/** CIP-30 methods moth answers. */
export type Cip30Method =
  | 'getNetworkId'
  | 'getBalance'
  | 'getUtxos'
  | 'getCollateral'
  | 'getUsedAddresses'
  | 'getUnusedAddresses'
  | 'getChangeAddress'
  | 'getRewardAddresses'
  | 'getExtensions'
  | 'signTx'
  | 'signData'
  | 'submitTx';

/**
 * Run one CIP-30 method against the wallet.
 *
 * A single entry point rather than eleven messaging keys: every method takes
 * the same session and returns a JSON-safe value, so the only thing that
 * varies is the name and the arguments.
 *
 * The methods that touch no chain — network id and the address getters — avoid
 * opening a Blockfrost-backed session, so a dApp can read addresses before a
 * project id is configured.
 */
export async function cardanoCip30(
  mnemonic: string,
  config: CardanoNetworkConfig,
  method: Cip30Method,
  params: unknown[],
  accountIndex?: number,
): Promise<Cip30Result> {
  const cip30 = await import('@shieldedtech/moth-wallet/cardano/cip30');
  const { deriveCardanoAddresses } = await import('@shieldedtech/moth-wallet/cardano');

  if (method === 'getNetworkId') return config.networkId;
  // Answerable without keys or chain access at all.
  if (method === 'getExtensions') return cip30.getExtensions();

  if (
    method === 'getUsedAddresses'
    || method === 'getUnusedAddresses'
    || method === 'getChangeAddress'
    || method === 'getRewardAddresses'
  ) {
    const addresses = await deriveCardanoAddresses(mnemonic, config, accountIndex);
    const session = { config, addresses } as never;
    if (method === 'getUnusedAddresses') return cip30.getUnusedAddresses();
    if (method === 'getChangeAddress') return cip30.getChangeAddress(session);
    if (method === 'getRewardAddresses') return cip30.getRewardAddresses(session);
    return cip30.getUsedAddresses(session, params[0] as never);
  }

  return openSession(mnemonic, config, async (session) => {
    switch (method) {
      case 'getBalance':
        return cip30.getBalance(session);
      // CIP-30 order: getUtxos(amount, paginate), getCollateral({ amount }).
      // Both amounts are CBOR hex, never decimal — see valueFromCbor.
      case 'getUtxos':
        return cip30.getUtxos(
          session,
          params[0] === undefined || params[0] === null ? undefined : String(params[0]),
          params[1] as never,
        );
      case 'getCollateral':
        return cip30.getCollateral(session, (params[0] ?? undefined) as never);
      case 'signTx':
        return cip30.signTx(session, String(params[0] ?? ''));
      case 'signData':
        return cip30.signData(session, String(params[0] ?? ''), String(params[1] ?? ''));
      case 'submitTx':
        return cip30.submitTx(session, String(params[0] ?? ''));
      default:
        throw cip30.cip30Error(cip30.CIP30_ERROR.InvalidRequest, `unknown method ${method}`);
    }
  }, accountIndex);
}
