import { Args } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { assertNotMainnet } from '../mainnet-guard.js';

const ALLOWED_KEYS = ['default-network', 'prover', 'proof-server-url', 'node-url', 'indexer-url', 'check-matrix', 'matrix-url'];

export default class Config extends BaseCommand {
  static override description = 'Get or set configuration values';

  // `action` is required. It was optional, declared ahead of a required `key`,
  // which @oclif/core rejects outright — with `action` absent a single argument
  // is ambiguous between an action and a key — so every invocation of this
  // command failed at spec validation and the body never ran (#53). Requiring it
  // changes no working behaviour, because nothing worked.
  static override args = {
    action: Args.string({ description: 'Action: get or set', required: true, options: ['get', 'set'] }),
    key: Args.string({ description: 'Configuration key', required: true }),
    value: Args.string({ description: 'Value to set (required for set)' }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Config);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    if (!ALLOWED_KEYS.includes(args.key)) {
      this.outputError('INVALID_INPUT', `Unknown config key "${args.key}". Valid keys: ${ALLOWED_KEYS.join(', ')}`);
      this.exit(1);
      return;
    }

    const configKey = `config/${args.key}`;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    if (args.action === 'get') {
      const data = await this.storage.read(configKey);
      if (!data) {
        this.outputError('INVALID_INPUT', `Config key "${args.key}" is not set`);
        this.exit(1);
        return;
      }
      this.outputSuccess({ key: args.key, value: decoder.decode(data) });
    } else {
      if (!args.value) {
        this.outputError('INVALID_INPUT', 'Value is required for set');
        this.exit(1);
        return;
      }
      // The second way mainnet can enter: stored, not passed. WalletManager falls
      // back to config.defaultNetwork for a wallet with no network of its own, so
      // a stored value reaches the same code paths without --network ever being
      // used. The flag guard cannot see this one.
      if (args.key === 'default-network') assertNotMainnet(args.value);

      if (args.key === 'prover' && args.value !== 'server' && args.value !== 'wasm') {
        this.outputError('INVALID_INPUT', 'Prover must be "server" or "wasm"');
        this.exit(1);
        return;
      }
      await this.storage.write(configKey, encoder.encode(args.value));
      this.outputSuccess({ key: args.key, value: args.value });
    }
  }
}
