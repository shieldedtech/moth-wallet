/**
 * Ledger v8 encodes signatures and verifying keys as bare hex strings; v9 tags
 * them as {tag, value} where tag selects schnorr or ECDSA. Both shapes have to
 * survive the trip to the dApp connector, which is why this is not a String().
 */

import {describe, expect, it} from 'vitest';
import {unwrapSignatureValue, signatureKindOf} from '../../../src/wallet/signature-encoding.js';

describe('unwrapSignatureValue', () => {
  it('passes a v8 bare hex string through unchanged', () => {
    expect(unwrapSignatureValue('deadbeef')).toBe('deadbeef');
  });

  it('takes the value out of a v9 tagged signature', () => {
    expect(unwrapSignatureValue({tag: 'schnorr', value: 'deadbeef'})).toBe('deadbeef');
  });

  it('does the same for an ECDSA-tagged value', () => {
    expect(unwrapSignatureValue({tag: 'ecdsa', value: 'cafe'})).toBe('cafe');
  });

  it('never yields the object-stringification that String() would produce', () => {
    expect(unwrapSignatureValue({tag: 'schnorr', value: 'deadbeef'})).not.toBe('[object Object]');
  });

  it('rejects a shape it does not understand rather than inventing one', () => {
    expect(() => unwrapSignatureValue({nope: 1} as never)).toThrow(/signature/i);
    expect(() => unwrapSignatureValue(undefined as never)).toThrow(/signature/i);
  });
});

describe('signatureKindOf', () => {
  it('reports schnorr for an untagged v8 value — v8 has no other kind', () => {
    expect(signatureKindOf('deadbeef')).toBe('schnorr');
  });

  it('reports the tag carried by a v9 value', () => {
    expect(signatureKindOf({tag: 'ecdsa', value: 'cafe'})).toBe('ecdsa');
    expect(signatureKindOf({tag: 'schnorr', value: 'cafe'})).toBe('schnorr');
  });
});
