// Generate a new API key for the daemon. The plaintext token
// `<id>.<secret>` is printed once on stdout and never persisted
// in recoverable form — capture it now or generate a new key.

import {Flags} from '@oclif/core';
import {ApiKeyStore} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../../base-command.js';

export default class DaemonKeyGen extends BaseCommand {
  static override description =
    'Generate a new API key for the daemon. The plaintext token is printed once on stdout — capture it now; the daemon stores only a hash and the plaintext cannot be recovered. Required for clients of `moth daemon serve --transport tcp` once stage-2 AuthN is enforced.';

  static override flags = {
    ...BaseCommand.baseFlags,
    label: Flags.string({
      description: 'Human label for this key. Surfaces in `moth daemon key list` and in the daemon\'s audit log when the key authenticates.',
      required: true,
    }),
    scopes: Flags.string({
      description: 'Comma-separated scopes for this key. `read` allows `getState`; `write` allows every L3-gated write verb (transfer, deploy, call, dust, maintenance). Use `read,write` for a key with full access (the default), or just `read` for a dashboard/observer key that cannot spend.',
      default: 'write',
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonKeyGen);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const scopes = flags.scopes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const store = new ApiKeyStore();
    let generated;
    try {
      generated = store.generate(flags.label, scopes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputError('INVALID_INPUT', msg);
      this.exit(2);
      return;
    }
    const {record, token} = generated;

    if (this.outputFormat === 'json') {
      // The token is included so machine consumers can capture it
      // programmatically — the daemon never persists it, so there's
      // no way to recover it after this single emission.
      this.outputSuccess({
        id: record.id,
        label: record.label,
        scopes: record.scopes ?? ['write'],
        token,
        createdAt: record.createdAt,
        directory: store.directory,
      });
      return;
    }

    this.log(`API key created: ${record.id} (${record.label})`);
    this.log(`Scopes:  ${(record.scopes ?? ['write']).join(', ')}`);
    this.log(`Stored:  ${store.directory}/${record.id}.key  (mode 0600)`);
    this.log('');
    this.log('Token (capture this — it is shown ONCE):');
    this.log('');
    this.log(`  ${token}`);
    this.log('');
    this.log('Usage:');
    this.log('  MOTH_DAEMON_TOKEN=<token> moth wallet status --bind 127.0.0.1:<port>');
    this.log('  connectDaemonTcp(host, port, {token})     # programmatic client');
  }
}
