import {describe, it, expect} from 'vitest';
import {
  parseProveTransactionParams,
  PROVE_TTL_MAX_MINUTES,
  PROVE_TTL_MIN_MINUTES,
} from '../../../src/daemon/wallet-rpc-parsers.js';
import {DaemonProtocolError} from '../../../src/daemon/protocol.js';

const NIGHT = '0'.repeat(64);

const valid = {
  type: 'unshielded' as const,
  tokenId: NIGHT,
  amount: '500000',
  to: 'mn_addr_test1abcdef',
};

describe('parseProveTransactionParams', () => {
  it('accepts a minimal valid payload and leaves ttlMinutes unset', () => {
    const out = parseProveTransactionParams(valid);
    expect(out.type).toBe('unshielded');
    expect(out.amount).toBe('500000');
    expect(out.to).toBe(valid.to);
    expect(out.ttlMinutes).toBeUndefined();
  });

  it('lowercases the token id', () => {
    const out = parseProveTransactionParams({...valid, tokenId: 'A'.repeat(64)});
    expect(out.tokenId).toBe('a'.repeat(64));
  });

  it('passes an in-range ttl through untouched', () => {
    expect(parseProveTransactionParams({...valid, ttlMinutes: 25}).ttlMinutes).toBe(25);
  });

  it('clamps a ttl above the ledger ceiling', () => {
    expect(parseProveTransactionParams({...valid, ttlMinutes: 6000}).ttlMinutes).toBe(PROVE_TTL_MAX_MINUTES);
  });

  it('clamps a zero or negative ttl up to the floor', () => {
    expect(parseProveTransactionParams({...valid, ttlMinutes: 0}).ttlMinutes).toBe(PROVE_TTL_MIN_MINUTES);
    expect(parseProveTransactionParams({...valid, ttlMinutes: -5}).ttlMinutes).toBe(PROVE_TTL_MIN_MINUTES);
  });

  it('floors a fractional ttl', () => {
    expect(parseProveTransactionParams({...valid, ttlMinutes: 12.9}).ttlMinutes).toBe(12);
  });

  it.each([
    ['non-object params', 'nope'],
    ['a bad type', {...valid, type: 'sideways'}],
    ['a short token id', {...valid, tokenId: 'abc'}],
    ['a non-numeric amount', {...valid, amount: '1.5'}],
    ['a zero amount', {...valid, amount: '0'}],
    ['an empty destination', {...valid, to: ''}],
    ['a non-finite ttl', {...valid, ttlMinutes: Number.NaN}],
    ['a string ttl', {...valid, ttlMinutes: '30'}],
    ['non-string details', {...valid, details: [1, 2]}],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseProveTransactionParams(payload)).toThrow(DaemonProtocolError);
  });

  it('reports INVALID_PARAMS on rejection', () => {
    try {
      parseProveTransactionParams({...valid, amount: '0'});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonProtocolError);
      expect((err as DaemonProtocolError).code).toBe('INVALID_PARAMS');
    }
  });
});
