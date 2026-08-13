// List API keys from ~/.moth/api-keys/. Plaintext secrets are
// never shown — `moth daemon key gen` is the only path that
// surfaces them, once.

import {ApiKeyStore} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../../base-command.js';

export default class DaemonKeyList extends BaseCommand {
  static override description =
    'List API keys configured for the daemon. Shows id, label, creation time, and revocation status — never the plaintext secret.';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonKeyList);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const store = new ApiKeyStore();
    const records = store.list();

    if (this.outputFormat === 'json') {
      this.outputSuccess({
        directory: store.directory,
        keys: records.map((r) => ({
          id: r.id,
          label: r.label,
          scopes: r.scopes ?? ['write'],
          createdAt: r.createdAt,
          revokedAt: r.revokedAt ?? null,
        })),
      });
      return;
    }

    if (records.length === 0) {
      this.log(`No API keys in ${store.directory}.`);
      this.log('Generate one with: moth daemon key gen --label "<purpose>"');
      return;
    }

    this.log(`${records.length} key${records.length === 1 ? '' : 's'} in ${store.directory}:`);
    this.log('');
    for (const r of records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const status = r.revokedAt ? `revoked ${r.revokedAt}` : 'active';
      const scopes = (r.scopes ?? ['write']).join('+');
      this.log(`  ${r.id}  ${r.label.padEnd(30)}  ${scopes.padEnd(12)}  ${status}  (created ${r.createdAt})`);
    }
  }
}
