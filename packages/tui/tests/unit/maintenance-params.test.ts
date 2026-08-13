import {describe, it, expect} from 'vitest';
import {
  DaemonProtocolError,
  parseInsertVerifierKeyParams,
  parseInsertVerifierKeysBatchParams,
} from '@shieldedtech/moth-wallet';

const validSingle = (): unknown => ({
  contractAddress: 'mn_addr_preprod1qz0123abc',
  circuitId: 'increment',
  verifierKeyPath: '/tmp/contract/keys/increment.verifier',
  artifactPath: '/tmp/contract/managed',
});

describe('parseInsertVerifierKeyParams', () => {
  it('accepts the minimal required shape', () => {
    const parsed = parseInsertVerifierKeyParams(validSingle());
    expect(parsed.contractAddress).toBe('mn_addr_preprod1qz0123abc');
    expect(parsed.circuitId).toBe('increment');
    expect(parsed.verifierKeyPath).toBe('/tmp/contract/keys/increment.verifier');
    expect(parsed.artifactPath).toBe('/tmp/contract/managed');
  });

  it('round-trips every optional field', () => {
    const parsed = parseInsertVerifierKeyParams({
      ...(validSingle() as object),
      projectDir: '/tmp/proj',
      timeoutSec: 900,
      summary: 'insert one',
      details: ['note'],
    });
    expect(parsed.projectDir).toBe('/tmp/proj');
    expect(parsed.timeoutSec).toBe(900);
    expect(parsed.summary).toBe('insert one');
    expect(parsed.details).toEqual(['note']);
  });

  it('rejects non-object payloads', () => {
    expect(() => parseInsertVerifierKeyParams(null)).toThrow(DaemonProtocolError);
    expect(() => parseInsertVerifierKeyParams('hex')).toThrow(/must be an object/);
  });

  it('rejects empty required fields', () => {
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), contractAddress: ''})).toThrow(/non-empty bech32m/);
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), circuitId: ''})).toThrow(/circuitId.*non-empty string/);
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), verifierKeyPath: ''})).toThrow(/verifierKeyPath.*non-empty/);
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), artifactPath: ''})).toThrow(/artifactPath.*non-empty/);
  });

  it('rejects non-positive timeoutSec', () => {
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), timeoutSec: 0})).toThrow(/positive number/);
    expect(() => parseInsertVerifierKeyParams({...(validSingle() as object), timeoutSec: 'never'})).toThrow(/positive number/);
  });
});

const validBatch = (): unknown => ({
  contractAddress: 'mn_addr_preprod1qz0123abc',
  artifactPath: '/tmp/contract/managed',
  entries: [
    {circuitId: 'increment', verifierKeyPath: '/tmp/keys/increment.verifier'},
    {circuitId: 'reset', verifierKeyPath: '/tmp/keys/reset.verifier'},
  ],
});

describe('parseInsertVerifierKeysBatchParams', () => {
  it('accepts a valid batch', () => {
    const parsed = parseInsertVerifierKeysBatchParams(validBatch());
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.circuitId).toBe('increment');
  });

  it('round-trips skipExisting as a boolean', () => {
    const parsed = parseInsertVerifierKeysBatchParams({
      ...(validBatch() as object),
      skipExisting: true,
    });
    expect(parsed.skipExisting).toBe(true);
  });

  it('rejects empty entries array', () => {
    expect(() => parseInsertVerifierKeysBatchParams({...(validBatch() as object), entries: []})).toThrow(/non-empty array/);
  });

  it('rejects entries that are not arrays', () => {
    expect(() => parseInsertVerifierKeysBatchParams({...(validBatch() as object), entries: 'increment'})).toThrow(/non-empty array/);
  });

  it('rejects entries with missing fields', () => {
    expect(() =>
      parseInsertVerifierKeysBatchParams({...(validBatch() as object), entries: [{circuitId: 'x'}]}),
    ).toThrow(/verifierKeyPath.*non-empty/);
    expect(() =>
      parseInsertVerifierKeysBatchParams({
        ...(validBatch() as object),
        entries: [{verifierKeyPath: '/tmp/keys/a.verifier'}],
      }),
    ).toThrow(/circuitId.*non-empty/);
  });

  it('reports the offending entry index in the error', () => {
    expect(() =>
      parseInsertVerifierKeysBatchParams({
        ...(validBatch() as object),
        entries: [
          {circuitId: 'a', verifierKeyPath: '/tmp/a.verifier'},
          {circuitId: 'b', verifierKeyPath: ''},
        ],
      }),
    ).toThrow(/entries\[1\]/);
  });

  it('treats skipExisting=undefined as undefined (not boolean)', () => {
    const parsed = parseInsertVerifierKeysBatchParams(validBatch());
    expect(parsed.skipExisting).toBeUndefined();
  });
});
