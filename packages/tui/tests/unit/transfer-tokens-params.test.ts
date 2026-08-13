import {describe, it, expect} from 'vitest';
import {
  DaemonProtocolError,
  parseTransferTokensParams,
  shortenHex,
  shortenAddress,
} from '@shieldedtech/moth-wallet';

const NIGHT = '0'.repeat(64);

const valid = (): unknown => ({
  type: 'unshielded',
  tokenId: NIGHT,
  amount: '1000000',
  to: 'mnu1qzabcabcabc',
});

describe('parseTransferTokensParams', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseTransferTokensParams(valid());
    expect(parsed.type).toBe('unshielded');
    expect(parsed.tokenId).toBe(NIGHT);
    expect(parsed.amount).toBe('1000000');
    expect(parsed.to).toBe('mnu1qzabcabcabc');
  });

  it('preserves an optional summary + details', () => {
    const parsed = parseTransferTokensParams({
      ...(valid() as object),
      summary: 'send 1 NIGHT to alice',
      details: ['extra context', 'more context'],
    });
    expect(parsed.summary).toBe('send 1 NIGHT to alice');
    expect(parsed.details).toEqual(['extra context', 'more context']);
  });

  it('normalizes tokenId to lowercase', () => {
    const upper = 'A'.repeat(64);
    const parsed = parseTransferTokensParams({...(valid() as object), tokenId: upper});
    expect(parsed.tokenId).toBe(upper.toLowerCase());
  });

  it('rejects non-object payloads', () => {
    expect(() => parseTransferTokensParams(null)).toThrow(DaemonProtocolError);
    expect(() => parseTransferTokensParams('hex')).toThrow(/must be an object/);
    expect(() => parseTransferTokensParams(42)).toThrow(/must be an object/);
  });

  it('rejects bad type values', () => {
    expect(() => parseTransferTokensParams({...(valid() as object), type: 'spooky'})).toThrow(
      /type must be 'shielded' or 'unshielded'/,
    );
    expect(() => parseTransferTokensParams({...(valid() as object), type: undefined})).toThrow(
      /type must be 'shielded' or 'unshielded'/,
    );
  });

  it('rejects malformed tokenIds (length, charset)', () => {
    expect(() => parseTransferTokensParams({...(valid() as object), tokenId: 'short'})).toThrow(
      /64-char hex/,
    );
    expect(() =>
      parseTransferTokensParams({...(valid() as object), tokenId: 'g'.repeat(64)}),
    ).toThrow(/64-char hex/);
    expect(() => parseTransferTokensParams({...(valid() as object), tokenId: 100})).toThrow(
      /64-char hex/,
    );
  });

  it('rejects non-numeric or negative amounts', () => {
    expect(() =>
      parseTransferTokensParams({...(valid() as object), amount: 'one million'}),
    ).toThrow(/non-negative decimal/);
    expect(() => parseTransferTokensParams({...(valid() as object), amount: '-5'})).toThrow(
      /non-negative decimal/,
    );
    expect(() => parseTransferTokensParams({...(valid() as object), amount: '0'})).toThrow(
      /greater than zero/,
    );
    expect(() => parseTransferTokensParams({...(valid() as object), amount: 1000000})).toThrow(
      /non-negative decimal/,
    );
  });

  it('accepts very large bigint amounts', () => {
    const big = '1' + '0'.repeat(40); // 10^40
    const parsed = parseTransferTokensParams({...(valid() as object), amount: big});
    expect(parsed.amount).toBe(big);
  });

  it('rejects missing or empty recipients', () => {
    expect(() => parseTransferTokensParams({...(valid() as object), to: ''})).toThrow(
      /non-empty bech32m/,
    );
    expect(() => parseTransferTokensParams({...(valid() as object), to: undefined})).toThrow(
      /non-empty bech32m/,
    );
  });

  it('rejects details that contain non-strings', () => {
    expect(() =>
      parseTransferTokensParams({...(valid() as object), details: ['ok', 42, 'also ok']}),
    ).toThrow(/array of strings/);
  });
});

describe('formatting helpers', () => {
  it('shortenHex truncates with an ellipsis when long enough', () => {
    expect(shortenHex('abcdef0123456789abcdef0123456789')).toBe('abcdef01…6789');
  });

  it('shortenHex returns short inputs unchanged', () => {
    expect(shortenHex('deadbeef')).toBe('deadbeef');
  });

  it('shortenAddress truncates bech32m-style strings', () => {
    expect(shortenAddress('mnu1qz0123456789abcdefghij012345')).toBe('mnu1qz0123…012345');
  });

  it('shortenAddress preserves short addresses', () => {
    expect(shortenAddress('mnu1short')).toBe('mnu1short');
  });
});
