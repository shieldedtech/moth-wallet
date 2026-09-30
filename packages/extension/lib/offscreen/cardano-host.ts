// Cardano / cNIGHT operations, hosted in the offscreen document.
//
// They live here and not in the service worker for the same reason the wallet
// does: Lucid loads the Cardano multiplatform library's WASM, and the offscreen
// document is the context in this extension that is set up to run it. Every
// import of the Cardano module below is dynamic so that a session which never
// opens the Cardano screen never pays for the WASM.

import type { CardanoNetworkConfig } from '@shieldedtech/moth-wallet/cardano/network';
import type { CardanoSession } from '@shieldedtech/moth-wallet/cardano/session';

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
  registeredCoinPublicKey: string | null;
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
      registeredCoinPublicKey: status.coinPublicKey,
      registrationUtxo: status.registrationUtxo
        ? `${status.registrationUtxo.txHash}#${status.registrationUtxo.outputIndex}`
        : null,
      generationRate: status.generation?.generationRate ?? null,
      currentCapacity: status.generation?.currentCapacity ?? null,
      maxCapacity: status.generation?.maxCapacity ?? null,
      generatingFrom: status.finality?.generatingFrom ?? null,
      secondsRemaining: status.finality?.secondsRemaining ?? null,
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
): Promise<{ txHash: string }> {
  const { deregisterFromDust } = await import('@shieldedtech/moth-wallet/cardano');
  return openSession(mnemonic, config, async (session) => ({
    txHash: await deregisterFromDust(session),
  }), accountIndex);
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
