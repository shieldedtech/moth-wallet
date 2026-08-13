// Builds the list of tokens the Send flow can transfer from wallet balances.
// Lives apart from the SendFlow view so the mapping stays testable, mirroring
// dust-view.ts / sync-view.ts. WASM-free: only pulls NIGHT_TOKEN_ID from the
// WASM-free tokens module, so UI pages don't bundle the ledger WASM.

import type { WalletBalances } from '@shieldedtech/moth-browser';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { t } from '../i18n';
import type { NativeAssetLabels } from './token-labels';

export interface SendableToken {
  id: string;
  kind: 'shielded' | 'unshielded';
  /** Short label for pills and headlines: "NIGHT" or a truncated token id. */
  symbol: string;
  /** Sub-label describing the token's kind. */
  name: string;
  balance: bigint;
  /** Base-unit exponent for display/entry: NIGHT is 6; native tokens are 0
   *  so their wallet values are displayed and submitted as-is. */
  decimals: number;
}

/**
 * Tokens the wallet can send, in display order: NIGHT first, then any other
 * unshielded tokens, then shielded tokens. NIGHT always appears (even at zero)
 * as the default selection. DUST is excluded — it only pays fees and can't be
 * transferred. NIGHT is unshielded-only, so it's filtered out of the shielded
 * side even if the shielded record happens to list it.
 *
 * `tokenNames` (user-assigned, tokenId → name) replaces the truncated-id
 * symbol; the truncated id then moves into the kind sub-label so the token
 * stays recognizable.
 */
export function sendableTokens(
  balances: WalletBalances | null,
  labels: NativeAssetLabels,
  tokenNames: Record<string, string> = {},
): SendableToken[] {
  const tokens: SendableToken[] = [];

  const push = (id: string, kind: 'shielded' | 'unshielded', balance: bigint) => {
    const custom = tokenNames[id];
    const name = custom
      ? t(kind === 'shielded' ? 'tokens_shieldedTokenWithId' : 'tokens_unshieldedTokenWithId', [shortId(id)])
      : t(kind === 'shielded' ? 'tokens_shieldedToken' : 'tokens_unshieldedToken');
    tokens.push({
      id,
      kind,
      symbol: custom ?? shortId(id),
      name,
      balance,
      decimals: 0,
    });
  };

  const unshielded = balances?.unshielded ?? {};
  tokens.push({
    id: NIGHT_TOKEN_ID,
    kind: 'unshielded',
    symbol: labels.night,
    name: 'Midnight',
    balance: unshielded[NIGHT_TOKEN_ID] ?? 0n,
    decimals: 6,
  });
  for (const [id, balance] of Object.entries(unshielded)) {
    if (id === NIGHT_TOKEN_ID) continue;
    push(id, 'unshielded', balance);
  }

  const shielded = balances?.shielded ?? {};
  for (const [id, balance] of Object.entries(shielded)) {
    if (id === NIGHT_TOKEN_ID) continue;
    push(id, 'shielded', balance);
  }

  return tokens;
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
