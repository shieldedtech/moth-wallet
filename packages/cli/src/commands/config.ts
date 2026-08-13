import { Args } from '@oclif/core';
import { BaseCommand } from '../base-command.js';

const ALLOWED_KEYS = ['default-network', 'prover', 'proof-server-url', 'node-url', 'indexer-url', 'check-matrix', 'matrix-url'];

export default class Config extends BaseCommand {
  static override description = 'Get or set configuration values';

  static override args = {
    action: Args.string({ description: 'Action: get or set', required: false, options: ['get', 'set'] }),
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
