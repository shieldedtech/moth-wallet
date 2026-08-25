import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { assertNotMainnet } from '../mainnet-guard.js';
import { chainTip } from '@shieldedtech/moth-wallet';

const ALLOWED_KEYS = ['default-network', 'prover', 'proof-server-url', 'node-url', 'indexer-url', 'check-matrix', 'matrix-url'];

/** Keys whose value is a URL, and which therefore have a shape worth checking. */
const URL_KEYS = new Set(['proof-server-url', 'node-url', 'indexer-url']);

export default class Config extends BaseCommand {
  static override description = 'Get, set, list or unset configuration values';

  static override examples = [
    '<%= config.bin %> config list',
    '<%= config.bin %> config get indexer-url',
    '<%= config.bin %> config set indexer-url https://indexer.preprod.midnight.network/api/v4/graphql',
    '<%= config.bin %> config unset indexer-url',
  ];

  // All optional, validated per action below. `action` was required and `key`
  // with it, which left no way to ask "what have I overridden?" — the question
  // you actually have when a stored value is breaking something (#78).
  static override args = {
    action: Args.string({ description: 'get, set, list or unset (default: list)', required: false, options: ['get', 'set', 'list', 'unset'] }),
    key: Args.string({ description: 'Configuration key', required: false }),
    value: Args.string({ description: 'Value to set (required for set)' }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description: 'Store a URL that could not be reached. The check exists because an unreachable indexer breaks later commands in ways that never mention config.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Config);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const action = args.action ?? 'list';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const configKey = (key: string) => `config/${key}`;

    if (action === 'list') {
      const entries: Array<{key: string; value: string}> = [];
      for (const key of ALLOWED_KEYS) {
        const data = await this.storage.read(configKey(key));
        if (data) entries.push({key, value: decoder.decode(data)});
      }
      if (this.outputFormat === 'json') {
        this.outputSuccess({overrides: entries});
        return;
      }
      if (entries.length === 0) {
        this.log('No configuration overrides. Every network uses its built-in defaults.');
        return;
      }
      // Said plainly because this is the output someone reaches for while
      // something else is misbehaving: these values outrank the defaults.
      this.log('Overrides in force — these take precedence over network defaults:');
      this.log('');
      for (const {key, value} of entries) this.log(`  ${key.padEnd(18)} ${value}`);
      this.log('');
      this.log('Remove one with: moth config unset <key>');
      return;
    }

    if (!args.key) {
      this.outputError('INVALID_INPUT', `"${action}" needs a key. Valid keys: ${ALLOWED_KEYS.join(', ')}`);
      this.exit(1);
      return;
    }
    if (!ALLOWED_KEYS.includes(args.key)) {
      this.outputError('INVALID_INPUT', `Unknown config key "${args.key}". Valid keys: ${ALLOWED_KEYS.join(', ')}`);
      this.exit(1);
      return;
    }

    if (action === 'get') {
      const data = await this.storage.read(configKey(args.key));
      if (!data) {
        this.outputError('INVALID_INPUT', `Config key "${args.key}" is not set`);
        this.exit(1);
        return;
      }
      this.outputSuccess({ key: args.key, value: decoder.decode(data) });
      return;
    }

    if (action === 'unset') {
      const data = await this.storage.read(configKey(args.key));
      if (!data) {
        this.outputError('INVALID_INPUT', `Config key "${args.key}" is not set, so there is nothing to unset`);
        this.exit(1);
        return;
      }
      await this.storage.delete(configKey(args.key));
      this.outputSuccess({ key: args.key, unset: true, previousValue: decoder.decode(data) });
      return;
    }

    // set
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

    if (URL_KEYS.has(args.key)) {
      const problem = await this.urlProblem(args.key, args.value);
      if (problem && !flags.force) {
        this.outputError(
          'INVALID_INPUT',
          `Refusing to store ${args.key}: ${problem}`,
          'A stored override outranks the network defaults for every later command, and a bad one ' +
            'surfaces far away from here — as "could not read a chain tip", or a sync that never ' +
            'starts. Pass --force to store it anyway.',
        );
        this.exit(1);
        return;
      }
      if (problem) this.warn(`Storing anyway (--force): ${problem}`);
    }

    await this.storage.write(configKey(args.key), encoder.encode(args.value));
    this.outputSuccess({ key: args.key, value: args.value });
  }

  /**
   * What is wrong with this URL, or null if nothing is.
   *
   * Only `indexer-url` is genuinely probed — one round trip asking for a block,
   * which is exactly what the commands that use it will do. The other two are
   * checked for shape only, and the message says so rather than implying a
   * reachability test that did not happen: a node URL is a WebSocket and a proof
   * server answers no GET this command could interpret.
   */
  private async urlProblem(key: string, value: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `"${value}" is not a URL`;
    }

    if (key === 'node-url') {
      return url.protocol === 'ws:' || url.protocol === 'wss:'
        ? null
        : `a node URL is a WebSocket endpoint, so it should start with ws:// or wss://, not ${url.protocol}//`;
    }
    if (key === 'proof-server-url') {
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? null
        : `expected http:// or https://, got ${url.protocol}//`;
    }

    // indexer-url: ask it the question every sync will ask.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `expected http:// or https://, got ${url.protocol}//`;
    }
    try {
      const tip = await chainTip(value);
      if (!tip) return `${value} answered, but not with a chain tip — is it a Midnight indexer GraphQL endpoint?`;
      this.log_verbose(`Indexer reachable: tip ${tip.height}`);
      return null;
    } catch (err) {
      return `${value} could not be reached (${err instanceof Error ? err.message : String(err)})`;
    }
  }
}
