// State view — the default dashboard sub-view.
// Visual style mirrors midnight-wallet-cli (Apache-2.0). See NOTICE.

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { SectionHeader } from '../../components/SectionHeader.js';
import type { WalletState, NetworkState } from '../../types.js';
import type { ChainStatus } from '../../hooks/useChainStatus.js';
import type {
  WalletCoinDetails, SubWalletProgress,
  ShieldedCoinInfo, UnshieldedCoinInfo, DustCoinInfo,
} from '@shieldedtech/moth-wallet';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet';
import {
  formatBalanceForToken, formatDustBalance, groupCoinsForDisplay,
  flattenBalanceRows,
} from '../../utils/balance.js';
import {
  formatTimeRemaining, truncateMiddle, windowRows, balanceBudget,
  type BalanceBudget,
} from '../../utils/display.js';

interface StateViewProps {
  wallet: WalletState | null;
  network: NetworkState;
  chain: ChainStatus;
  isUnlocked: boolean;
  paused?: boolean;
  addresses?: { unshielded: string; shielded: string; dust: string };
  shieldedBalances?: Record<string, bigint>;
  unshieldedBalances?: Record<string, bigint>;
  dustBalance?: bigint;
  coins?: WalletCoinDetails;
  subProgress?: SubWalletProgress;
}

// Common label width so Address / Sync / Balance / Pending line up vertically.
const LABEL_WIDTH = 10;

function Label({ children }: { children: string }) {
  return <Text dimColor>{children.padEnd(LABEL_WIDTH)}</Text>;
}

/** Colored ▸ + bold title sub-section marker. */
function SubHeading({ color, label }: { color: string; label: string }) {
  return (
    <Box>
      <Text color={color}>▸ </Text>
      <Text bold color={color}>{label}</Text>
    </Box>
  );
}

/** Sync row — ● synced / ○ syncing with applied/total + %. */
function SyncRow({ progress }: { progress?: { applied: number; total: number } }) {
  const applied = progress?.applied ?? 0;
  const total = progress?.total ?? 0;
  // 0/0 means the sub-wallet has nothing to sync (e.g. empty unshielded wallet) — treat as synced.
  const synced = applied >= total;
  const pct = total === 0 ? 100 : Math.floor((applied / total) * 100);
  return (
    <Box>
      <Label>Sync</Label>
      <Text color={synced ? 'green' : 'yellow'}>{synced ? '● synced' : '○ syncing'}</Text>
      <Text dimColor>  ·  </Text>
      <Text>{applied.toLocaleString()} / {total.toLocaleString()}</Text>
      {!synced && (
        <Text dimColor>  ({pct}%)</Text>
      )}
    </Box>
  );
}

function pluralCoins(n: number) { return `${n} coin${n === 1 ? '' : 's'}`; }

interface TokenGroup<T> { token: string; total: bigint; coins: T[]; }

function groupByToken<T extends { value: bigint; type: string }>(coins: readonly T[]): TokenGroup<T>[] {
  const map = new Map<string, TokenGroup<T>>();
  for (const c of coins) {
    const existing = map.get(c.type);
    if (existing) {
      existing.total += c.value;
      existing.coins.push(c);
    } else {
      map.set(c.type, { token: c.type, total: c.value, coins: [c] });
    }
  }
  return Array.from(map.values());
}
// Fungible grouping (which folds booked coins into the total) lives in
// utils/balance.ts as groupCoinsForDisplay so the arithmetic is unit-testable
// without rendering Ink. Note groupByToken above no longer serves the dust
// block — nothing calls it; removing it is a separate cleanup.

/** Shared "Balance" block for shielded + unshielded — grouped by token, nested coins. */
function FungibleBalanceBlock({
  available, booked = [], tokenType, budget,
}: {
  available: readonly (ShieldedCoinInfo | UnshieldedCoinInfo)[];
  /**
   * Coins this wallet has booked as inputs for a transaction still in flight —
   * a send, or a DUST registration reserving its own NIGHT UTxOs. They settle
   * back to the wallet on apply, and the core counts them toward the balance it
   * reports (see extractBalancesPartial in core/src/sync/wallet-sync.ts), so
   * counting them here is what keeps this view equal to the extension's.
   *
   * UNSHIELDED ONLY. Shielded pending also holds INCOMING coins, and folding
   * those in would over-count receipts.
   */
  booked?: readonly (ShieldedCoinInfo | UnshieldedCoinInfo)[];
  tokenType: 'shielded' | 'unshielded';
  budget: BalanceBudget;
}) {
  if (available.length === 0 && booked.length === 0) {
    return (
      <Box>
        <Label>Balance</Label>
        <Text dimColor>(none)</Text>
      </Box>
    );
  }

  const groups = groupCoinsForDisplay(available, booked, tokenType);
  // Flat row list, then one budget over the whole block — see flattenBalanceRows.
  const rows = flattenBalanceRows(groups);
  // The "and N more" line costs a row of its own when there is going to be one.
  const { shown, hidden } = windowRows(
    rows,
    rows.length > budget.maxRows ? budget.maxRows - 1 : budget.maxRows,
  );

  return (
    <Box flexDirection="column">
      <Box><Label>Balance</Label></Box>
      <Box marginLeft={2} flexDirection="column">
        {shown.map((row) => {
          const g = groups[row.group];
          if (row.kind === 'group') {
            const display = g.token === NIGHT_TOKEN_ID && tokenType === 'unshielded'
              ? 'NIGHT'
              : truncateMiddle(g.token, budget.tokenWidth);
            return (
              <Box key={`g${row.group}`}>
                <Text>{display}</Text>
                <Text>  </Text>
                <Text bold>{formatBalanceForToken(g.total, g.token, tokenType)}</Text>
                <Text dimColor>  ({pluralCoins(g.coins.length)})</Text>
              </Box>
            );
          }
          const coin = g.coins[row.coin!];
          return (
            <Box key={`g${row.group}c${row.coin}`} marginLeft={2}>
              <Text dimColor>· </Text>
              <Text>{formatBalanceForToken(coin.value, coin.type, tokenType)}</Text>
              {/*
                Shielded coins show their Merkle index and a nonce prefix: those
                identify the coin well enough to pick it out, and are what a
                circuit needs in order to spend it. Full values come from
                `moth balance --coins`; this is a dashboard, so keep it short.
              */}
              {'mtIndex' in coin && coin.mtIndex != null && (
                <Text dimColor>  #{String(coin.mtIndex)}</Text>
              )}
              {'nonce' in coin && typeof coin.nonce === 'string' && (
                <Text dimColor>  {coin.nonce.slice(0, 8)}…</Text>
              )}
              {coin.registered && <Text color="yellow"> [Registered for Dust]</Text>}
              {coin.booked && <Text color="cyan"> [in flight]</Text>}
            </Box>
          );
        })}
        {hidden > 0 && <Text dimColor>… and {hidden.toLocaleString()} more</Text>}
      </Box>
    </Box>
  );
}

/** Dust "Balance" block — single DUST token with per-coin generation status. */
function DustBalanceBlock({
  totalDust, available, budget,
}: {
  totalDust: bigint;
  available: readonly DustCoinInfo[];
  budget: BalanceBudget;
}) {
  if (available.length === 0) {
    return (
      <Box>
        <Label>Balance</Label>
        <Text bold>{formatDustBalance(totalDust)}</Text>
        <Text dimColor> DUST</Text>
      </Box>
    );
  }
  const now = new Date();
  // A deregistered coin renders a second line, so cost it as two rows.
  const dustRows = (coin: DustCoinInfo) => (coin.dtime ? 2 : 1);
  const { shown, hidden } = windowRows(
    available,
    available.length > budget.maxRows ? budget.maxRows - 1 : budget.maxRows,
    dustRows,
  );
  return (
    <Box flexDirection="column">
      <Box>
        <Label>Balance</Label>
        <Text bold>{formatDustBalance(totalDust)}</Text>
        <Text dimColor> DUST  ({pluralCoins(available.length)})</Text>
      </Box>
      <Box marginLeft={LABEL_WIDTH} flexDirection="column">
        {shown.map((coin, idx) => {
          const timeRemaining = formatTimeRemaining(coin.maxCapReachedAt, now);
          const isComplete = coin.generatedNow >= coin.maxCap;
          return (
            <Box key={idx} flexDirection="column">
              <Box>
                <Text dimColor>· </Text>
                <Text>{formatDustBalance(coin.generatedNow)}</Text>
                <Text dimColor> / {formatDustBalance(coin.maxCap)} max</Text>
                {!coin.dtime && (
                  <Text color={isComplete ? 'green' : 'cyan'}>  ({timeRemaining})</Text>
                )}
              </Box>
              {coin.dtime && (
                <Box marginLeft={2}>
                  <Text dimColor>Deregistered: {coin.dtime.toLocaleString()}</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {hidden > 0 && <Text dimColor>· … and {hidden.toLocaleString()} more</Text>}
      </Box>
    </Box>
  );
}

function PendingRow({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Box>
      <Label>Pending</Label>
      <Text>{pluralCoins(count)}</Text>
    </Box>
  );
}

export function StateView({
  wallet, network, chain, isUnlocked, paused,
  addresses, shieldedBalances: _sb, unshieldedBalances: _ub, dustBalance,
  coins, subProgress,
}: StateViewProps) {
  const { stdout } = useStdout();
  // Ink renders the whole frame at once and has no viewport: a frame taller than
  // the terminal corrupts its redraw, collapsing lines onto one another (the
  // note in components/Select.tsx describes the same failure). Coin counts come
  // from chain state, so every block below is bounded by what the terminal can
  // actually show.
  const budget = balanceBudget(stdout?.rows, stdout?.columns);
  const showWallets = isUnlocked && wallet && addresses;
  const headerHint = wallet ? `${network.id} · ${wallet.name}` : network.id;
  const chips = paused ? [{ label: 'PAUSED', color: 'yellow' }] : undefined;

  return (
    <Box flexDirection="column">
      <SectionHeader title="Wallet State" hint={headerHint} chips={chips} />
      <Box flexDirection="column" paddingLeft={2}>

      {/* Network section — chain telemetry, distinct from per-wallet data */}
      <Box flexDirection="column" marginBottom={2}>
        <SubHeading color="green" label="Network" />
        <Box marginLeft={2} flexDirection="column" marginTop={1}>
          <Box>
            <Label>Node</Label>
            <Text color={chain.connected ? 'green' : 'red'}>
              {chain.connected ? '● connected' : '○ disconnected'}
            </Text>
            <Text dimColor>  ·  </Text>
            <Text>{chain.peers}</Text>
            <Text dimColor> peers</Text>
          </Box>
          <Box>
            <Label>Block</Label>
            <Text>{chain.blockHeight}</Text>
            <Text dimColor>  (epoch </Text>
            <Text>{chain.epoch}</Text>
            <Text dimColor>, slot </Text>
            <Text>{chain.slot}</Text>
            <Text dimColor>)</Text>
          </Box>
        </Box>
      </Box>

      {/* No wallet / locked banner — replaces the wallet sections until unlocked. */}
      {!showWallets && (
        <Box flexDirection="column" marginBottom={1}>
          <SubHeading color="cyan" label="Wallet" />
          <Box marginLeft={2} flexDirection="column" marginTop={1}>
            {!wallet ? (
              <Text dimColor>No wallet. Press <Text bold color="cyan">k</Text> to manage keys.</Text>
            ) : !isUnlocked ? (
              <Box flexDirection="column">
                <Box>
                  <Label>Name</Label>
                  <Text color="cyan">{wallet.name}</Text>
                  <Text color="red"> · locked</Text>
                </Box>
                <Box marginTop={1}>
                  <Text dimColor>Press </Text>
                  <Text bold color="cyan">k</Text>
                  <Text dimColor> to unlock from the Keys screen.</Text>
                </Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      )}

      {showWallets && (
        <>
          {/* Shielded Wallet */}
          <Box flexDirection="column" marginBottom={1}>
            <SubHeading color="magenta" label="Shielded Wallet" />
            <Box marginLeft={2} flexDirection="column" marginTop={1}>
              <Box>
                <Label>Address</Label>
                <Text>{addresses.shielded}</Text>
              </Box>
              <SyncRow progress={subProgress?.shielded} />
              <FungibleBalanceBlock
                available={coins?.shielded.available ?? []}
                tokenType="shielded"
                budget={budget}
              />
              <PendingRow count={coins?.shielded.pending.length ?? 0} />
            </Box>
          </Box>

          {/* Unshielded Wallet */}
          <Box flexDirection="column" marginBottom={1}>
            <SubHeading color="blue" label="Unshielded Wallet" />
            <Box marginLeft={2} flexDirection="column" marginTop={1}>
              <Box>
                <Label>Address</Label>
                <Text>{addresses.unshielded}</Text>
              </Box>
              <SyncRow progress={subProgress?.unshielded} />
              <FungibleBalanceBlock
                available={coins?.unshielded.available ?? []}
                booked={coins?.unshielded.pending ?? []}
                tokenType="unshielded"
                budget={budget}
              />
              <PendingRow count={coins?.unshielded.pending.length ?? 0} />
            </Box>
          </Box>

          {/* Dust Wallet */}
          <Box flexDirection="column" marginBottom={1}>
            <SubHeading color="yellow" label="Dust Wallet" />
            <Box marginLeft={2} flexDirection="column" marginTop={1}>
              <Box>
                <Label>Address</Label>
                <Text>{addresses.dust}</Text>
              </Box>
              <SyncRow progress={subProgress?.dust} />
              <DustBalanceBlock
                totalDust={dustBalance ?? 0n}
                available={coins?.dust.available ?? []}
                budget={budget}
              />
              <PendingRow count={coins?.dust.pending.length ?? 0} />
            </Box>
          </Box>
        </>
      )}
      </Box>
    </Box>
  );
}
