import { describe, it, expect } from 'vitest';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { NIGHT_TOKEN_ID } from '@shieldedtech/moth-wallet/types/tokens';
import { sendableTokens } from '../lib/ui/token-list';
import { nativeAssetLabelsForNetwork } from '../lib/ui/token-labels';

const SHIELDED_ID = 'a'.repeat(64);
const OTHER_UNSHIELDED_ID = 'b'.repeat(64);

// sendableTokens only reads .shielded / .unshielded; the rest of the shape is
// irrelevant, so tests pass a minimal balances object cast to the full type.
function balances(partial: { shielded?: Record<string, bigint>; unshielded?: Record<string, bigint> }): WalletBalances {
  return { shielded: {}, unshielded: {}, ...partial } as WalletBalances;
}

const labels = nativeAssetLabelsForNetwork('preview');

describe('sendableTokens', () => {
  it('always leads with NIGHT, even when balances are empty or null', () => {
    for (const b of [null, balances({})]) {
      const tokens = sendableTokens(b, labels);
      expect(tokens[0]).toMatchObject({ id: NIGHT_TOKEN_ID, kind: 'unshielded', symbol: 'tNIGHT', balance: 0n });
    }
  });

  it('reports the NIGHT balance from the unshielded record', () => {
    const [night] = sendableTokens(balances({ unshielded: { [NIGHT_TOKEN_ID]: 5_000_000n } }), labels);
    expect(night).toMatchObject({ symbol: 'tNIGHT', balance: 5_000_000n });
  });

  it('includes other unshielded and shielded tokens, tagged kind', () => {
    const tokens = sendableTokens(
      balances({
        unshielded: { [NIGHT_TOKEN_ID]: 1n, [OTHER_UNSHIELDED_ID]: 2n },
        shielded: { [SHIELDED_ID]: 3n },
      }),
      labels,
    );
    const other = tokens.find((t) => t.id === OTHER_UNSHIELDED_ID);
    const shielded = tokens.find((t) => t.id === SHIELDED_ID);
    expect(other).toMatchObject({ kind: 'unshielded', balance: 2n });
    expect(shielded).toMatchObject({ kind: 'shielded', balance: 3n });
    // Native tokens get a truncated-id symbol, not a raw 64-char id.
    expect(shielded?.symbol).toBe(`${SHIELDED_ID.slice(0, 8)}…`);
  });

  it('marks NIGHT as 6-decimal and every native token as raw (0 decimals)', () => {
    const tokens = sendableTokens(
      balances({
        unshielded: { [NIGHT_TOKEN_ID]: 1n, [OTHER_UNSHIELDED_ID]: 2n },
        shielded: { [SHIELDED_ID]: 3n },
      }),
      labels,
    );
    expect(tokens.find((t) => t.id === NIGHT_TOKEN_ID)?.decimals).toBe(6);
    expect(tokens.find((t) => t.id === OTHER_UNSHIELDED_ID)?.decimals).toBe(0);
    expect(tokens.find((t) => t.id === SHIELDED_ID)?.decimals).toBe(0);
  });

  it('orders NIGHT, then other unshielded, then shielded', () => {
    const tokens = sendableTokens(
      balances({
        unshielded: { [NIGHT_TOKEN_ID]: 1n, [OTHER_UNSHIELDED_ID]: 2n },
        shielded: { [SHIELDED_ID]: 3n },
      }),
      labels,
    );
    expect(tokens.map((t) => t.kind)).toEqual(['unshielded', 'unshielded', 'shielded']);
    expect(tokens[0].id).toBe(NIGHT_TOKEN_ID);
  });

  it('uses the user-assigned name as the symbol and keeps the id in the sub-label', () => {
    const tokens = sendableTokens(
      balances({
        unshielded: { [NIGHT_TOKEN_ID]: 1n },
        shielded: { [SHIELDED_ID]: 3n },
      }),
      labels,
      { [SHIELDED_ID]: 'Loyalty points', [NIGHT_TOKEN_ID]: 'ignored' },
    );
    const shielded = tokens.find((t) => t.id === SHIELDED_ID);
    expect(shielded?.symbol).toBe('Loyalty points');
    expect(shielded?.name).toBe(`${SHIELDED_ID.slice(0, 8)}… · Shielded token`);
    // NIGHT keeps its native label — user names never override it.
    expect(tokens[0]?.symbol).toBe('tNIGHT');
  });

  it('never lists DUST or a shielded NIGHT (NIGHT is unshielded-only)', () => {
    const tokens = sendableTokens(balances({ shielded: { [NIGHT_TOKEN_ID]: 9n, [SHIELDED_ID]: 3n } }), labels);
    // NIGHT appears exactly once, on the unshielded side.
    expect(tokens.filter((t) => t.id === NIGHT_TOKEN_ID)).toHaveLength(1);
    expect(tokens.find((t) => t.id === NIGHT_TOKEN_ID)?.kind).toBe('unshielded');
  });
});
