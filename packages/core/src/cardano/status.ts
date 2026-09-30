import { IndexerClient, type DustGenerationStatus } from '../network/indexer-client.js';
import { fetchTxBlockTime, finalityCountdown, type FinalityCountdown } from './finality.js';
import { dustAuthPolicyId, dustValidatorAddress } from './blueprint.js';
import { cnightUnit, type CardanoNetworkConfig } from './network.js';
import { findRegistration, readCardanoBalance, type CardanoBalance } from './registration.js';
import type { CardanoAddresses, CardanoSession } from './session.js';

export interface CardanoDustStatus {
  readonly addresses: CardanoAddresses;
  readonly network: CardanoNetworkConfig['network'];
  readonly balance: CardanoBalance;
  /** Cardano-side truth: the registration UTXO, if the mapping validator holds one for us. */
  readonly registered: boolean;
  readonly coinPublicKey: string | null;
  readonly registrationUtxo: { readonly txHash: string; readonly outputIndex: number } | null;
  /**
   * Midnight-side view, keyed by the reward address. Null when the indexer has
   * not seen this stake key — a fresh registration shows as registered on
   * Cardano well before the Midnight side reports generation, and conflating
   * the two would read as a failed registration.
   */
  readonly generation: DustGenerationStatus | null;
  /**
   * How long until Midnight acts on the registration.
   *
   * Null when there is no registration, or when its transaction is not in a
   * block yet — in both cases there is nothing to count down from, and a
   * guessed start time would be worse than none.
   */
  readonly finality: FinalityCountdown | null;
  readonly cnightUnit: string;
  readonly dustAuthPolicyId: string;
  readonly mappingValidatorAddress: string;
}

/**
 * Read both halves of the picture: what Cardano says the mapping is, and what
 * the Midnight indexer says is being generated from it.
 *
 * They disagree legitimately and often — Cardano confirms in seconds, the
 * Midnight side only after the bridge has observed the UTXO — so both are
 * reported rather than reconciled into a single boolean.
 */
export async function readCardanoDustStatus(
  session: CardanoSession,
  indexerUrl: string,
): Promise<CardanoDustStatus> {
  const [balance, registration, mappingValidatorAddress] = await Promise.all([
    readCardanoBalance(session),
    findRegistration(session),
    dustValidatorAddress(session.config),
  ]);

  let generation: DustGenerationStatus | null = null;
  try {
    const client = new IndexerClient(indexerUrl);
    const statuses = await client.getDustGenerationStatus([session.addresses.rewardAddress]);
    generation = statuses[0] ?? null;
  } catch {
    // An indexer that is down, or too old to know the field, must not take the
    // Cardano-side answer down with it — that half is the one the user can act on.
    generation = null;
  }

  // Computed whenever a registration exists.
  //
  // It used to be skipped once the indexer reported `registered`, on the
  // assumption that meant the wait was over. It does not: the indexer reports
  // the mapping as soon as it observes it, which is hours before Cardano
  // finalises it. Gating on that suppressed the countdown during exactly the
  // window it exists for, and the UI then read the absent countdown as
  // "usable now".
  //
  // `finality` stays null only when the registration transaction is not in a
  // block yet or Blockfrost cannot answer — genuinely unknown, which callers
  // must not render as elapsed.
  let finality: FinalityCountdown | null = null;
  if (registration) {
    const confirmedAt = await fetchTxBlockTime(session.config, registration.utxo.txHash);
    if (confirmedAt !== null) finality = finalityCountdown(confirmedAt);
  }

  return {
    addresses: session.addresses,
    network: session.config.network,
    balance,
    registered: registration !== null,
    coinPublicKey: registration?.coinPublicKey ?? null,
    registrationUtxo: registration
      ? { txHash: registration.utxo.txHash, outputIndex: registration.utxo.outputIndex }
      : null,
    generation,
    finality,
    cnightUnit: cnightUnit(session.config),
    dustAuthPolicyId,
    mappingValidatorAddress,
  };
}
