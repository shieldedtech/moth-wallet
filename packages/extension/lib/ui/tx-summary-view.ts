// Turns the balance-approval summary (what a dApp transaction takes from the
// wallet) into display rows. Kept apart from the Approval screen so the mapping
// is testable, like dust-view.ts and token-list.ts. WASM-free: only the NIGHT
// token id constant crosses over from core.

import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import type { TxSummaryDTO, TxTokenAmountDTO } from '../offscreen/messaging';
import { formatDustFee, formatTokenBalance } from './format';
import type { NativeAssetLabels } from './token-labels';
import type { TokenKind } from '../../components/moth/token';

export interface TxSummaryRow {
  /** Which list the row came from. */
  direction: 'pay' | 'receive';
  icon: TokenKind;
  /** "1.5", "7", "< 0.000001" — formatted in the token's own denomination. */
  amount: string;
  /** "tNIGHT", "DUST", a user-assigned token name, or a truncated token id. */
  symbol: string;
  /** Truncated token id when `symbol` is a user-assigned name, so the token stays identifiable. */
  detail: string | null;
}

/**
 * Display rows for a summary, spends first. Amounts follow the conventions the
 * rest of the wallet uses: NIGHT has six decimals, DUST its own denomination,
 * and every other token is a whole-unit count. A negative or malformed amount
 * is rendered as received rather than dropped, so nothing silently vanishes.
 */
export function txSummaryRows(
  summary: TxSummaryDTO,
  labels: NativeAssetLabels,
  tokenNames: Record<string, string> = {},
): TxSummaryRow[] {
  const toRow = (direction: TxSummaryRow['direction']) => (entry: TxTokenAmountDTO): TxSummaryRow => {
    const raw = parseAmount(entry.amount);
    if (entry.kind === 'dust') {
      return { direction, icon: 'dust', amount: formatDustFee(raw), symbol: labels.dust, detail: null };
    }
    if (entry.kind === 'unshielded' && entry.tokenId === NIGHT_TOKEN_ID) {
      return { direction, icon: 'night', amount: formatTokenBalance(raw, 6), symbol: labels.night, detail: null };
    }
    const custom = tokenNames[entry.tokenId];
    return {
      direction,
      icon: entry.kind,
      amount: formatTokenBalance(raw, 0),
      symbol: custom ?? shortId(entry.tokenId),
      detail: custom ? shortId(entry.tokenId) : null,
    };
  };
  return [...summary.spends.map(toRow('pay')), ...summary.receives.map(toRow('receive'))];
}

function parseAmount(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
