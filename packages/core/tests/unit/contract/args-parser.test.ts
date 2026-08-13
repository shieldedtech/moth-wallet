import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseArgs, toPositionalArgs } from '../../../src/contract/args-parser.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parseArgs', () => {
  it('should return {} for empty input', async () => {
    expect(await parseArgs('')).toEqual({});
    expect(await parseArgs('   ')).toEqual({});
  });

  it('should parse inline JSON objects', async () => {
    expect(await parseArgs('{"amount": 100}')).toEqual({ amount: 100 });
  });

  it('should parse inline JSON arrays', async () => {
    expect(await parseArgs('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('should throw InvalidInputError on malformed inline JSON', async () => {
    await expect(parseArgs('{not json')).rejects.toThrow(/Invalid JSON/);
  });

  it('should not leak file content in the error message for malformed JSON', async () => {
    await expect(parseArgs('{"secret": "sh0uldNotLeak"')).rejects.not.toThrow(/sh0uldNotLeak/);
  });

  describe('file references (@file.json)', () => {
    const testDir = join(tmpdir(), `args-parser-test-${Date.now()}`);
    const validFile = join(testDir, 'args.json');
    const malformedFile = join(testDir, 'bad.json');

    beforeAll(async () => {
      await mkdir(testDir, { recursive: true });
      await writeFile(validFile, JSON.stringify({ amount: 42 }));
      await writeFile(malformedFile, '{not json');
    });

    afterAll(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should load and parse a JSON file', async () => {
      expect(await parseArgs(`@${validFile}`)).toEqual({ amount: 42 });
    });

    it('should throw InvalidInputError for a missing file', async () => {
      await expect(parseArgs(`@${join(testDir, 'missing.json')}`)).rejects.toThrow(/not found/);
    });

    it('should throw InvalidInputError for malformed JSON in a file', async () => {
      await expect(parseArgs(`@${malformedFile}`)).rejects.toThrow(/Invalid JSON/);
    });
  });

  describe('Bytes<N> hex convention', () => {
    it('should convert a top-level hex string to a Uint8Array', async () => {
      const result = await parseArgs('"0x00112233"');
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual([0x00, 0x11, 0x22, 0x33]);
    });

    it('should convert hex strings nested in an object', async () => {
      const result = (await parseArgs('{"govKey": "0xaabbcc"}')) as Record<string, unknown>;
      expect(result.govKey).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.govKey as Uint8Array)).toEqual([0xaa, 0xbb, 0xcc]);
    });

    it('should convert hex strings nested in an array (positional constructor args)', async () => {
      const result = (await parseArgs('[1, "0xdeadbeef", true]')) as unknown[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(Uint8Array);
      expect(Array.from(result[1] as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect(result[2]).toBe(true);
    });

    it('should convert hex strings nested inside array elements that are objects', async () => {
      const result = (await parseArgs('[{"asset": "0x0a0b"}]')) as Array<Record<string, unknown>>;
      expect(result[0].asset).toBeInstanceOf(Uint8Array);
      expect(Array.from(result[0].asset as Uint8Array)).toEqual([0x0a, 0x0b]);
    });

    it('should leave non-matching strings untouched', async () => {
      const result = (await parseArgs('{"label": "0xnotHex", "empty": "0x", "plain": "hello"}')) as Record<
        string,
        unknown
      >;
      expect(result.label).toBe('0xnotHex');
      expect(result.empty).toBe('0x');
      expect(result.plain).toBe('hello');
    });

    it('should reject odd-length hex strings', async () => {
      await expect(parseArgs('"0xabc"')).rejects.toThrow(/even number of hex digits/);
    });
  });

  describe('Uint/Field bigint-literal convention', () => {
    it('should convert a top-level bigint-literal string to a bigint', async () => {
      expect(await parseArgs('"5000000n"')).toBe(5000000n);
    });

    it('should convert a negative bigint-literal string to a bigint', async () => {
      expect(await parseArgs('"-1n"')).toBe(-1n);
    });

    it('should convert bigint-literal strings nested in an array (positional constructor args)', async () => {
      const result = (await parseArgs('["5000000n", "0xdeadbeef", "20000000n"]')) as unknown[];
      expect(result[0]).toBe(5000000n);
      expect(result[1]).toBeInstanceOf(Uint8Array);
      expect(result[2]).toBe(20000000n);
    });

    it('should convert bigint-literal strings nested in an object', async () => {
      const result = (await parseArgs('{"maxPos": "5000000n"}')) as Record<string, unknown>;
      expect(result.maxPos).toBe(5000000n);
    });

    it('should leave bare JSON numbers as JS numbers (backward compatible)', async () => {
      expect(await parseArgs('[100, 200]')).toEqual([100, 200]);
      expect(typeof (await parseArgs('100'))).toBe('number');
    });

    it('should leave non-matching strings untouched', async () => {
      const result = (await parseArgs('{"label": "5000000", "notQuiteBigint": "n5000000"}')) as Record<
        string,
        unknown
      >;
      expect(result.label).toBe('5000000');
      expect(result.notQuiteBigint).toBe('n5000000');
    });
  });
});

describe('toPositionalArgs', () => {
  it('should return [] for undefined', () => {
    expect(toPositionalArgs(undefined)).toEqual([]);
  });

  it('should return [] for an empty object (no-args sentinel from parseArgs)', () => {
    expect(toPositionalArgs({})).toEqual([]);
  });

  it('should pass arrays through unchanged (already positional)', () => {
    const arr = [1, 2, 3];
    expect(toPositionalArgs(arr)).toBe(arr);
  });

  it('should wrap a single non-array value in a one-element array', () => {
    expect(toPositionalArgs(42)).toEqual([42]);
    expect(toPositionalArgs('hello')).toEqual(['hello']);
  });

  it('should wrap a non-empty object in a one-element array', () => {
    const obj = { amount: 5 };
    expect(toPositionalArgs(obj)).toEqual([obj]);
  });
});
