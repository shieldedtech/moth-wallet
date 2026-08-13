import {describe, it, expect} from 'vitest';
import {DaemonProtocolError, parseCallCircuitParams} from '@shieldedtech/moth-wallet';

const valid = (): unknown => ({
  contractAddress: 'mn_addr_preprod1qz0123abc',
  circuitName: 'increment',
  artifactPath: '/tmp/contract/managed',
});

describe('parseCallCircuitParams', () => {
  it('accepts the minimal required shape', () => {
    const parsed = parseCallCircuitParams(valid());
    expect(parsed.contractAddress).toBe('mn_addr_preprod1qz0123abc');
    expect(parsed.circuitName).toBe('increment');
    expect(parsed.artifactPath).toBe('/tmp/contract/managed');
    expect(parsed.args).toBeUndefined();
    expect(parsed.witnessesPath).toBeUndefined();
    expect(parsed.projectDir).toBeUndefined();
    expect(parsed.timeoutSec).toBeUndefined();
  });

  it('round-trips every optional field', () => {
    const parsed = parseCallCircuitParams({
      ...(valid() as object),
      args: '@/tmp/args.json',
      witnessesPath: '/tmp/contract/witnesses.js',
      projectDir: '/tmp/project',
      timeoutSec: 300,
      summary: 'Test call',
      details: ['additional context'],
    });
    expect(parsed.args).toBe('@/tmp/args.json');
    expect(parsed.witnessesPath).toBe('/tmp/contract/witnesses.js');
    expect(parsed.projectDir).toBe('/tmp/project');
    expect(parsed.timeoutSec).toBe(300);
    expect(parsed.summary).toBe('Test call');
    expect(parsed.details).toEqual(['additional context']);
  });

  it('rejects non-object payloads', () => {
    expect(() => parseCallCircuitParams(null)).toThrow(DaemonProtocolError);
    expect(() => parseCallCircuitParams('hex')).toThrow(/must be an object/);
    // Arrays pass typeof === 'object', so we get a field-level failure
    // instead of the top-level one — but still rejected.
    expect(() => parseCallCircuitParams([])).toThrow(DaemonProtocolError);
  });

  it('rejects empty contract address', () => {
    expect(() => parseCallCircuitParams({...(valid() as object), contractAddress: ''})).toThrow(
      /non-empty bech32m/,
    );
    expect(() => parseCallCircuitParams({...(valid() as object), contractAddress: undefined})).toThrow(
      /non-empty bech32m/,
    );
  });

  it('rejects empty circuit name', () => {
    expect(() => parseCallCircuitParams({...(valid() as object), circuitName: ''})).toThrow(
      /non-empty string/,
    );
  });

  it('rejects empty artifact path', () => {
    expect(() => parseCallCircuitParams({...(valid() as object), artifactPath: ''})).toThrow(
      /non-empty path/,
    );
  });

  it('rejects non-string args', () => {
    expect(() => parseCallCircuitParams({...(valid() as object), args: {foo: 'bar'}})).toThrow(
      /args must be a string/,
    );
    expect(() => parseCallCircuitParams({...(valid() as object), args: 42})).toThrow(
      /args must be a string/,
    );
  });

  it('rejects non-positive timeoutSec', () => {
    expect(() => parseCallCircuitParams({...(valid() as object), timeoutSec: 0})).toThrow(
      /positive number/,
    );
    expect(() => parseCallCircuitParams({...(valid() as object), timeoutSec: -10})).toThrow(
      /positive number/,
    );
    expect(() => parseCallCircuitParams({...(valid() as object), timeoutSec: 'forever'})).toThrow(
      /positive number/,
    );
  });

  it('treats null optional fields the same as undefined', () => {
    const parsed = parseCallCircuitParams({
      ...(valid() as object),
      args: null,
      witnessesPath: null,
      projectDir: null,
      details: null,
    });
    expect(parsed.args).toBeUndefined();
    expect(parsed.witnessesPath).toBeUndefined();
    expect(parsed.projectDir).toBeUndefined();
    expect(parsed.details).toBeUndefined();
  });

  it('rejects details containing non-strings', () => {
    expect(() =>
      parseCallCircuitParams({...(valid() as object), details: ['ok', 99]}),
    ).toThrow(/array of strings/);
  });
});
