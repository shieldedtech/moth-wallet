// JSON-safe serialization for MCP tool results. WalletBalances and
// ActivityEntry carry bigint and Date fields — a plain JSON.stringify
// throws on the former and mangles intent on the latter. Following the
// daemon wire convention (wallet-rpc-types.ts): all bigints cross the
// JSON boundary as decimal strings; dates as ISO strings or null.
//
// Pure functions, no I/O — unit-tested in tests/unit/mcp-serialize.test.ts.

import {
  NIGHT_DENOMINATION,
  NIGHT_TOKEN_ID,
  formatBalance,
  formatDustBalance,
  unshieldedSplit,
  type ActivityEntry,
  type WalletBalances,
} from '@shieldedtech/moth-wallet';

/** `Record<string, bigint>` → `Record<string, string>` (decimal). */
export function bigintRecordToStrings(record: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) out[k] = v.toString();
  return out;
}

/**
 * Balances snapshot for the wallet_balances tool. Mirrors the CLI's
 * `moth balance -o json` shape (BalanceResult in commands/balance.ts):
 * raw decimal strings plus display-formatted figures, including the
 * spendable split — the headline unshielded figure counts coins
 * reserved by in-flight transactions that the SDK will not spend (#72).
 */
export function serializeBalances(walletName: string, networkId: string, b: WalletBalances) {
  const unshieldedNight = b.unshielded[NIGHT_TOKEN_ID] ?? 0n;
  const shieldedNight = b.shielded[NIGHT_TOKEN_ID] ?? 0n;
  const totalNight = unshieldedNight + shieldedNight;
  const split = unshieldedSplit(b.coins, NIGHT_TOKEN_ID);

  const otherTokens: Array<{tokenId: string; type: 'unshielded' | 'shielded'; amount: string}> = [];
  for (const [tokenId, amount] of Object.entries(b.unshielded)) {
    if (tokenId === NIGHT_TOKEN_ID) continue;
    otherTokens.push({tokenId, type: 'unshielded', amount: amount.toString()});
  }
  for (const [tokenId, amount] of Object.entries(b.shielded)) {
    if (tokenId === NIGHT_TOKEN_ID) continue;
    otherTokens.push({tokenId, type: 'shielded', amount: amount.toString()});
  }

  return {
    wallet: walletName,
    network: networkId,
    synced: b.synced,
    syncProgress: b.syncProgress,
    night: {
      unshielded: unshieldedNight.toString(),
      shielded: shieldedNight.toString(),
      total: totalNight.toString(),
      totalFormatted: formatBalance(totalNight, NIGHT_DENOMINATION),
      unshieldedAvailable: split.available.toString(),
      unshieldedReserved: split.reserved.toString(),
    },
    dust: {
      speck: b.dust.toString(),
      formatted: formatDustBalance(b.dust),
    },
    otherTokens,
  };
}

/** One activity entry, JSON-safe. */
export function serializeActivityEntry(entry: ActivityEntry) {
  return {
    hash: entry.hash,
    kind: entry.kind,
    status: entry.status,
    timestamp: entry.timestamp ? entry.timestamp.toISOString() : null,
    deltas: entry.deltas.map((d) => ({
      tokenType: d.tokenType,
      kind: d.kind,
      amount: d.amount.toString(),
    })),
    dustDelta: entry.dustDelta.toString(),
    counterparty: entry.counterparty,
    fees: entry.fees === null ? null : entry.fees.toString(),
    pending: entry.pending,
    ...(entry.outputs !== undefined ? {outputs: entry.outputs} : {}),
  };
}

export function serializeActivity(entries: readonly ActivityEntry[]) {
  return entries.map(serializeActivityEntry);
}
