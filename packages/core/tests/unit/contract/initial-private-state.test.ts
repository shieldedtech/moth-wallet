import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveInitialPrivateState } from '../../../src/contract/initial-private-state.js';
import { InvalidInputError } from '../../../src/types/errors.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('resolveInitialPrivateState', () => {
  const testDir = join(tmpdir(), `initial-private-state-test-${Date.now()}`);

  // Witness modules under test. Each is a standalone ESM file the function loads
  // via dynamic import(), mirroring how a real --witnesses module is consumed.
  const factoryModule = join(testDir, 'factory.mjs');
  const factoryReturnsValue = { count: 7n };
  const plainModule = join(testDir, 'plain.mjs');
  const plainValue = { seed: 'abc' };
  const bothModule = join(testDir, 'both.mjs');
  const badFactoryModule = join(testDir, 'bad-factory.mjs');
  const emptyModule = join(testDir, 'empty.mjs');
  const brokenModule = join(testDir, 'broken.mjs');

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      factoryModule,
      'export function makeInitialPrivateState() { return { count: 7n }; }\n',
    );
    await writeFile(plainModule, 'export const initialPrivateState = { seed: "abc" };\n');
    // makeInitialPrivateState must win over initialPrivateState when both are present.
    await writeFile(
      bothModule,
      'export function makeInitialPrivateState() { return { from: "factory" }; }\n' +
        'export const initialPrivateState = { from: "plain" };\n',
    );
    await writeFile(badFactoryModule, 'export const makeInitialPrivateState = 42;\n');
    await writeFile(emptyModule, 'export const somethingElse = true;\n');
    await writeFile(brokenModule, 'this is not valid javascript ===\n');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('precedence 1: --private-state flag', () => {
    it('parses inline JSON from the flag', async () => {
      expect(await resolveInitialPrivateState('{"amount": 100}', undefined)).toEqual({ amount: 100 });
    });

    it('applies the parseArgs typed-value conventions (hex, bigint)', async () => {
      const result = (await resolveInitialPrivateState('{"key": "0x00ff", "n": "5n"}', undefined)) as {
        key: Uint8Array;
        n: bigint;
      };
      expect(result.key).toEqual(new Uint8Array([0x00, 0xff]));
      expect(result.n).toBe(5n);
    });

    it('takes precedence over the witness module', async () => {
      // Flag wins even when a witness module with its own private state is given.
      expect(await resolveInitialPrivateState('{"from": "flag"}', factoryModule)).toEqual({ from: 'flag' });
    });
  });

  describe('precedence 2: witness makeInitialPrivateState() factory', () => {
    it('calls the factory and returns its result', async () => {
      expect(await resolveInitialPrivateState(undefined, factoryModule)).toEqual(factoryReturnsValue);
    });

    it('invokes onVerbose noting the factory was used', async () => {
      const messages: string[] = [];
      await resolveInitialPrivateState(undefined, factoryModule, { onVerbose: (m) => messages.push(m) });
      expect(messages).toEqual([expect.stringContaining('makeInitialPrivateState()')]);
    });

    it('wins over a plain initialPrivateState export in the same module', async () => {
      expect(await resolveInitialPrivateState(undefined, bothModule)).toEqual({ from: 'factory' });
    });

    it('throws InvalidInputError when makeInitialPrivateState is not a function', async () => {
      await expect(resolveInitialPrivateState(undefined, badFactoryModule)).rejects.toThrow(InvalidInputError);
      await expect(resolveInitialPrivateState(undefined, badFactoryModule)).rejects.toThrow(/not a function/);
    });
  });

  describe('precedence 3: witness initialPrivateState export', () => {
    it('returns the plain exported value', async () => {
      expect(await resolveInitialPrivateState(undefined, plainModule)).toEqual(plainValue);
    });

    it('invokes onVerbose noting the plain export was used', async () => {
      const messages: string[] = [];
      await resolveInitialPrivateState(undefined, plainModule, { onVerbose: (m) => messages.push(m) });
      expect(messages).toEqual([expect.stringContaining('initialPrivateState export')]);
    });
  });

  describe('precedence 4: default {}', () => {
    it('returns {} when neither flag nor witness path is given', async () => {
      expect(await resolveInitialPrivateState(undefined, undefined)).toEqual({});
    });

    it('returns {} when the witness module exports neither hook', async () => {
      expect(await resolveInitialPrivateState(undefined, emptyModule)).toEqual({});
    });
  });

  describe('error handling', () => {
    it('throws InvalidInputError when the witness module fails to load', async () => {
      await expect(resolveInitialPrivateState(undefined, brokenModule)).rejects.toThrow(InvalidInputError);
    });

    it('throws InvalidInputError when the witness module does not exist', async () => {
      const missing = join(testDir, 'does-not-exist.mjs');
      await expect(resolveInitialPrivateState(undefined, missing)).rejects.toThrow(/Failed to load witness module/);
    });
  });
});
