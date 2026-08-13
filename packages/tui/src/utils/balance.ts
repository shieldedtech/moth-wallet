// TUI-specific balance helpers. Generic formatters live in core
// (@shieldedtech/moth-wallet) so the daemon handlers can use them
// without depending on Ink. Re-exported here for TUI callers that
// expect the old import path. Visual style mirrors midnight-wallet-cli
// (Apache-2.0); see NOTICE.

import {
  NIGHT_TOKEN_ID,
  NIGHT_DENOMINATION,
  DUST_DENOMINATION,
  formatBalance,
  formatDustBalance,
} from '@shieldedtech/moth-wallet';

export {NIGHT_DENOMINATION, DUST_DENOMINATION, formatBalance, formatDustBalance};

/**
 * NIGHT is only the native unshielded token. A shielded token with all-zeros ID is
 * not NIGHT and has no known unit. NIGHT (unshielded) uses STAR denomination (10^6);
 * all other tokens display raw value.
 */
export function formatBalanceForToken(
  balance: bigint,
  tokenId: string,
  tokenType: 'shielded' | 'unshielded',
): string {
  const isNight = tokenType === 'unshielded' && tokenId === NIGHT_TOKEN_ID;
  const denomination = isNight ? NIGHT_DENOMINATION : 1n;
  return formatBalance(balance, denomination);
}

export interface DisplayCoin {
  value: bigint;
  type: string;
  /** Registered for DUST generation — unshielded NIGHT only. */
  registered: boolean;
  /** Booked as an input by an in-flight transaction; settles back on apply. */
  booked: boolean;
}

export interface DisplayTokenGroup {
  token: string;
  /** Sum over every coin in the group, booked ones included. */
  total: bigint;
  coins: DisplayCoin[];
}

interface CoinLike { value: bigint; type: string; registeredForDustGeneration?: boolean }

/**
 * Group a sub-wallet's coins by token for display, counting booked coins toward
 * each token's total.
 *
 * `booked` coins are the wallet's own inputs, reserved by a transaction still in
 * flight — a send, or a DUST registration reserving its NIGHT UTxOs. They settle
 * back on apply, and the core already counts them toward the balance it reports
 * (see extractBalancesPartial in core/src/sync/wallet-sync.ts). Including them
 * here is what keeps the TUI's totals equal to the extension's, and it stops a
 * token whose coins are ALL booked from vanishing from the list.
 *
 * Pass `booked` for UNSHIELDED coins only: shielded pending also holds INCOMING
 * coins, and folding those in would over-count receipts.
 */
export function groupCoinsForDisplay(
  available: readonly CoinLike[],
  booked: readonly CoinLike[],
  tokenType: 'shielded' | 'unshielded',
): DisplayTokenGroup[] {
  const isRegistered = (coin: CoinLike) =>
    tokenType === 'unshielded' && coin.registeredForDustGeneration === true;

  const rows: DisplayCoin[] = [
    ...available.map((c) => ({ value: c.value, type: c.type, registered: isRegistered(c), booked: false })),
    ...booked.map((c) => ({ value: c.value, type: c.type, registered: isRegistered(c), booked: true })),
  ];

  const groups = new Map<string, DisplayTokenGroup>();
  for (const row of rows) {
    const existing = groups.get(row.type);
    if (existing) {
      existing.total += row.value;
      existing.coins.push(row);
    } else {
      groups.set(row.type, { token: row.type, total: row.value, coins: [row] });
    }
  }
  return Array.from(groups.values());
}

/**
 * Parse a user-entered NIGHT amount ("5", "1.25") into raw STAR units
 * (10^6 per NIGHT). Decimals beyond 6 places are truncated.
 */
export function parseNightAmount(amount: string): bigint {
  if (!amount.includes('.')) return BigInt(amount) * 1_000_000n;
  const [int, dec = ''] = amount.split('.');
  return BigInt(int || '0') * 1_000_000n + BigInt(dec.padEnd(6, '0').slice(0, 6));
}
