import { describe, expect, it } from 'vitest';
import { parseNodeAuthHeader } from '../lib/background/settings';
import { nodeHostFor } from '../lib/background/node-auth-header';

// No real token appears anywhere in this file. The value is a credential and
// this repo is public; a working one in a fixture would be leaked on push.
const TOKEN = 'test-token-not-a-real-credential';

describe('parseNodeAuthHeader', () => {
  it('accepts a well-formed header', () => {
    expect(parseNodeAuthHeader({ name: 'x-shielded-ratelimit-bypass', value: TOKEN })).toEqual({
      name: 'x-shielded-ratelimit-bypass',
      value: TOKEN,
    });
  });

  it('trims surrounding whitespace, which pasting a token reliably introduces', () => {
    expect(parseNodeAuthHeader({ name: '  x-token  ', value: `  ${TOKEN}\n` })).toEqual({
      name: 'x-token',
      value: TOKEN,
    });
  });

  it('treats a blank value as no header at all', () => {
    // Sending the header with an empty value is not the same as omitting it —
    // some gateways treat the two differently — and it is never what the user
    // meant by clearing the field.
    expect(parseNodeAuthHeader({ name: 'x-token', value: '' })).toBeUndefined();
    expect(parseNodeAuthHeader({ name: 'x-token', value: '   ' })).toBeUndefined();
  });

  it('treats a blank name as no header at all', () => {
    expect(parseNodeAuthHeader({ name: '', value: TOKEN })).toBeUndefined();
    expect(parseNodeAuthHeader({ name: '   ', value: TOKEN })).toBeUndefined();
  });

  // Header-name and value injection. A name carrying a colon or CRLF, or a value
  // carrying CRLF, could smuggle a second header past the intended one.
  it('rejects a name outside the RFC 7230 token characters', () => {
    for (const name of ['x-token: evil', 'x token', 'x-token\r\nX-Evil', 'x/token', 'x@token', 'x(token)']) {
      expect(parseNodeAuthHeader({ name, value: TOKEN })).toBeUndefined();
    }
  });

  it('accepts a name whose only offence is surrounding whitespace', () => {
    // 'x-token\n' trims to a clean 'x-token' — nothing dangerous survives, and
    // rejecting it would punish a paste. What must not survive is a separator
    // in the MIDDLE, which the case above covers.
    expect(parseNodeAuthHeader({ name: 'x-token\n', value: TOKEN })?.name).toBe('x-token');
    expect(parseNodeAuthHeader({ name: '\tx-token ', value: TOKEN })?.name).toBe('x-token');
  });

  it('rejects a value containing CR or LF', () => {
    expect(parseNodeAuthHeader({ name: 'x-token', value: `${TOKEN}\r\nX-Evil: 1` })).toBeUndefined();
    expect(parseNodeAuthHeader({ name: 'x-token', value: `${TOKEN}\nX-Evil: 1` })).toBeUndefined();
  });

  it('accepts the punctuation RFC 7230 actually allows in a token', () => {
    expect(parseNodeAuthHeader({ name: "x-a!#$%&'*+.^_`|~-9", value: TOKEN })?.name).toBe("x-a!#$%&'*+.^_`|~-9");
  });

  it('returns undefined for anything that is not a name/value pair', () => {
    for (const input of [undefined, null, '', 42, [], { name: 'x-token' }, { value: TOKEN }]) {
      expect(parseNodeAuthHeader(input)).toBeUndefined();
    }
  });
});

describe('nodeHostFor', () => {
  it('extracts the host, so the rule matches regardless of scheme or path', () => {
    // The node is reached as both wss:// and https:// on one origin; matching
    // the host covers both without depending on how the URL was spelled.
    expect(nodeHostFor('https://rpc.preprod.midnight.network')).toBe('rpc.preprod.midnight.network');
    expect(nodeHostFor('wss://rpc.preprod.midnight.network/')).toBe('rpc.preprod.midnight.network');
    expect(nodeHostFor('https://rpc.preprod.midnight.network:443/path')).toBe('rpc.preprod.midnight.network');
  });

  it('handles a local node', () => {
    expect(nodeHostFor('ws://localhost:9944')).toBe('localhost');
  });

  it('returns null for an unusable URL rather than guessing', () => {
    // A null host means no rule is installed — the credential is never attached
    // to a host we could not identify.
    for (const url of ['', 'not-a-url', 'rpc.preprod.midnight.network']) {
      expect(nodeHostFor(url)).toBeNull();
    }
  });
});
