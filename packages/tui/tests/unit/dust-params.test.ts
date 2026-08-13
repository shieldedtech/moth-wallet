import {describe, it, expect} from 'vitest';
import {
  DaemonProtocolError,
  parseDustRegisterParams,
  parseDustDeregisterParams,
} from '@shieldedtech/moth-wallet';

describe('parseDustRegisterParams', () => {
  it('treats undefined as the empty object', () => {
    expect(parseDustRegisterParams(undefined)).toEqual({});
    expect(parseDustRegisterParams(null)).toEqual({});
  });

  it('round-trips receiver + summary + details', () => {
    const parsed = parseDustRegisterParams({
      receiver: 'mn_addr_dust_preprod1q...',
      summary: 'register all',
      details: ['note one'],
    });
    expect(parsed.receiver).toBe('mn_addr_dust_preprod1q...');
    expect(parsed.summary).toBe('register all');
    expect(parsed.details).toEqual(['note one']);
  });

  it('rejects non-object payloads', () => {
    expect(() => parseDustRegisterParams('register')).toThrow(DaemonProtocolError);
    expect(() => parseDustRegisterParams(42)).toThrow(/must be an object or omitted/);
  });

  it('rejects empty-string receiver', () => {
    expect(() => parseDustRegisterParams({receiver: ''})).toThrow(/non-empty bech32m/);
  });

  it('rejects non-string receiver', () => {
    expect(() => parseDustRegisterParams({receiver: 42})).toThrow(/receiver must be a string/);
  });

  it('rejects non-string details', () => {
    expect(() => parseDustRegisterParams({details: ['ok', 1, 'also ok']})).toThrow(/array of strings/);
  });
});

describe('parseDustDeregisterParams', () => {
  it('treats undefined as the empty object', () => {
    expect(parseDustDeregisterParams(undefined)).toEqual({});
    expect(parseDustDeregisterParams(null)).toEqual({});
  });

  it('round-trips summary + details', () => {
    const parsed = parseDustDeregisterParams({
      summary: 'undo dust',
      details: ['no more dust'],
    });
    expect(parsed.summary).toBe('undo dust');
    expect(parsed.details).toEqual(['no more dust']);
  });

  it('rejects non-object payloads', () => {
    expect(() => parseDustDeregisterParams('deregister')).toThrow(DaemonProtocolError);
    expect(() => parseDustDeregisterParams(99)).toThrow(/must be an object or omitted/);
  });

  it('rejects non-string details', () => {
    expect(() => parseDustDeregisterParams({details: [{}, 'ok']})).toThrow(/array of strings/);
  });
});
