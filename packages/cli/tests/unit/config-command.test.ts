import {describe, expect, it} from 'vitest';
import Config from '../../src/commands/config.js';

describe('config argument spec', () => {
  // Every argument optional, validated in the body. `action` and `key` were both
  // required, which left no way to ask "what have I overridden?" — the question
  // you have precisely when a stored value is breaking something else (#78).
  it('lets you run it with no arguments at all', () => {
    expect(Config.args.action.required).toBeFalsy();
    expect(Config.args.key.required).toBeFalsy();
    expect(Config.args.value.required).toBeFalsy();
  });

  it('offers list and unset, not just get and set', () => {
    expect(Config.args.action.options).toEqual(expect.arrayContaining(['get', 'set', 'list', 'unset']));
  });

  // An optional positional ahead of a required one is what oclif rejects at spec
  // validation, and what #53 reported. Nothing here is required, so the order is
  // safe — this asserts it stays that way.
  it('never places an optional positional before a required one', () => {
    const order = ['action', 'key', 'value'] as const;
    const required = order.map((k) => Boolean(Config.args[k].required));
    const firstOptional = required.indexOf(false);
    const lastRequired = required.lastIndexOf(true);
    expect(firstOptional === -1 || lastRequired < firstOptional).toBe(true);
  });

  it('has a force flag, because the reachability check must be overridable', () => {
    expect(Config.flags.force).toBeDefined();
    expect(Config.flags.force.default).toBe(false);
  });
});

describe('wallet generate', () => {
  it('offers --no-birthday, so an offline creation stays possible', async () => {
    const {default: Generate} = await import('../../src/commands/wallet/generate.js');
    expect(Generate.flags['no-birthday']).toBeDefined();
    expect(Generate.flags['no-birthday'].default).toBe(false);
  });
});
