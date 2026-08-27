import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../src/base-command.js';
import { assertNotMainnet, isMainnet } from '../../src/mainnet-guard.js';

/** refuseMainnet stops the process, so exit is trapped rather than taken. */
function trapExit() {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  return { stderr, exit };
}

afterEach(() => vi.restoreAllMocks());

describe('isMainnet', () => {
  it('recognises mainnet and nothing else', () => {
    expect(isMainnet('mainnet')).toBe(true);
    for (const id of ['devnet', 'preprod', 'preview', 'qanet', 'undeployed', undefined]) {
      expect(isMainnet(id)).toBe(false);
    }
  });
});

describe('assertNotMainnet', () => {
  it('passes other networks straight through', () => {
    expect(assertNotMainnet('preprod')).toBe('preprod');
  });

  it('prints the warning and exits 1', () => {
    const { stderr, exit } = trapExit();
    expect(() => assertNotMainnet('mainnet')).toThrow('exit:1');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('should NOT be used with real funds'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

// The regression. #25: the refusal lived inside getNetworkConfig, and twelve
// commands never call it — including `wallet generate`, which derived mainnet
// addresses, wrote a keystore, printed a recovery phrase and exited 0. Attaching
// it to the flag every command inherits is what makes the guard unconditional.
describe('the --network flag itself refuses mainnet', () => {
  it('has a parse hook, so no command can inherit the flag without the guard', () => {
    expect(typeof BaseCommand.baseFlags.network.parse).toBe('function');
  });

  it('refuses mainnet through that hook', async () => {
    const { exit } = trapExit();
    const parse = BaseCommand.baseFlags.network.parse as (input: string, ctx: unknown, opts: unknown) => Promise<string>;
    await expect(parse('mainnet', {}, {})).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('leaves every other network usable', async () => {
    const parse = BaseCommand.baseFlags.network.parse as (input: string, ctx: unknown, opts: unknown) => Promise<string>;
    await expect(parse('preprod', {}, {})).resolves.toBe('preprod');
  });
});
