import type { CardanoNetworkConfig } from './network.js';

/**
 * How long after a Cardano registration confirms before Midnight will act on it.
 *
 * Midnight waits for Cardano *finality*, not just a confirmation: the bridge
 * cannot safely observe a registration that a rollback could still undo.
 * Cardano's security parameter is k = 2160 blocks at roughly 20 seconds each,
 * which is the ~12 hours users see.
 *
 * This is why the Cardano flow feels so different from registering native
 * NIGHT, which takes effect in minutes — same DUST, different chain underneath.
 */
export const CNIGHT_FINALITY_SECONDS = 43_200;

/**
 * When the registration transaction landed in a block, as unix seconds.
 *
 * Read from the chain rather than remembered locally: a countdown that starts
 * when *this browser* submitted would restart on another device, and would be
 * wrong for a registration made from the dApp or the CLI.
 *
 * Returns null when the transaction is submitted but not yet in a block, or
 * when Blockfrost cannot answer — the caller shows "pending", not a wrong time.
 */
export async function fetchTxBlockTime(
  config: CardanoNetworkConfig,
  txHash: string,
): Promise<number | null> {
  if (!config.blockfrostProjectId) return null;
  try {
    const response = await fetch(`${config.blockfrostUrl}/txs/${txHash}`, {
      headers: { project_id: config.blockfrostProjectId },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { block_time?: unknown };
    return typeof body.block_time === 'number' ? body.block_time : null;
  } catch {
    return null;
  }
}

export interface FinalityCountdown {
  /** Unix seconds the registration was included in a block. */
  readonly confirmedAt: number;
  /** Unix seconds Midnight is expected to act on it. */
  readonly generatingFrom: number;
  /** Seconds still to wait, floored at 0. */
  readonly secondsRemaining: number;
  readonly elapsed: boolean;
}

export function finalityCountdown(confirmedAt: number, now = Date.now()): FinalityCountdown {
  const generatingFrom = confirmedAt + CNIGHT_FINALITY_SECONDS;
  const secondsRemaining = Math.max(0, generatingFrom - Math.floor(now / 1000));
  return {
    confirmedAt,
    generatingFrom,
    secondsRemaining,
    elapsed: secondsRemaining === 0,
  };
}

/**
 * A countdown in the units someone actually reads it in.
 *
 * Deliberately coarse above an hour and precise below it: "11h 43m" is the
 * useful answer for most of the wait, and only the last stretch benefits from
 * minutes alone.
 */
export function describeCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'any moment now';
  const hours = Math.floor(secondsRemaining / 3_600);
  const minutes = Math.floor((secondsRemaining % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${secondsRemaining}s`;
}
