import {describe, it, expect} from 'vitest';
import {DaemonProtocolError, parseDeployContractParams} from '@shieldedtech/moth-wallet';

const valid = (): unknown => ({
  artifactPath: '/tmp/contract/managed',
});

describe('parseDeployContractParams', () => {
  it('accepts the minimal required shape', () => {
    const parsed = parseDeployContractParams(valid());
    expect(parsed.artifactPath).toBe('/tmp/contract/managed');
    expect(parsed.witnessesPath).toBeUndefined();
    expect(parsed.projectDir).toBeUndefined();
    expect(parsed.timeoutSec).toBeUndefined();
  });

  it('round-trips every optional field', () => {
    const parsed = parseDeployContractParams({
      ...(valid() as object),
      witnessesPath: '/tmp/contract/witnesses.js',
      projectDir: '/tmp/project',
      timeoutSec: 600,
      summary: 'Test deploy',
      details: ['additional context'],
    });
    expect(parsed.witnessesPath).toBe('/tmp/contract/witnesses.js');
    expect(parsed.projectDir).toBe('/tmp/project');
    expect(parsed.timeoutSec).toBe(600);
    expect(parsed.summary).toBe('Test deploy');
    expect(parsed.details).toEqual(['additional context']);
  });

  it('rejects non-object payloads', () => {
    expect(() => parseDeployContractParams(null)).toThrow(DaemonProtocolError);
    expect(() => parseDeployContractParams('hex')).toThrow(/must be an object/);
  });

  it('rejects empty artifact path', () => {
    expect(() => parseDeployContractParams({...(valid() as object), artifactPath: ''})).toThrow(
      /non-empty path/,
    );
    expect(() => parseDeployContractParams({...(valid() as object), artifactPath: undefined})).toThrow(
      /non-empty path/,
    );
  });

  it('rejects non-positive timeoutSec', () => {
    expect(() => parseDeployContractParams({...(valid() as object), timeoutSec: 0})).toThrow(
      /positive number/,
    );
    expect(() => parseDeployContractParams({...(valid() as object), timeoutSec: -5})).toThrow(
      /positive number/,
    );
    expect(() => parseDeployContractParams({...(valid() as object), timeoutSec: 'forever'})).toThrow(
      /positive number/,
    );
  });

  it('rejects non-string optional path fields', () => {
    expect(() =>
      parseDeployContractParams({...(valid() as object), witnessesPath: 42}),
    ).toThrow(/witnessesPath must be a string/);
    expect(() =>
      parseDeployContractParams({...(valid() as object), projectDir: {nested: 'object'}}),
    ).toThrow(/projectDir must be a string/);
  });

  it('treats null optional fields the same as undefined', () => {
    const parsed = parseDeployContractParams({
      ...(valid() as object),
      witnessesPath: null,
      projectDir: null,
      details: null,
    });
    expect(parsed.witnessesPath).toBeUndefined();
    expect(parsed.projectDir).toBeUndefined();
    expect(parsed.details).toBeUndefined();
  });

  it('rejects details containing non-strings', () => {
    expect(() =>
      parseDeployContractParams({...(valid() as object), details: ['ok', 99]}),
    ).toThrow(/array of strings/);
  });
});
