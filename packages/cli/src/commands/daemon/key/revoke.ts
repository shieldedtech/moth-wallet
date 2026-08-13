// Mark an API key as revoked. The on-disk record is kept (its id
// still shows up in old audit lines) but the daemon's auth handler
// refuses to authenticate the key. There is no un-revoke — generate
// a new key if the operator needs continued access.

import {Args} from '@oclif/core';
import {ApiKeyStore} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../../base-command.js';

export default class DaemonKeyRevoke extends BaseCommand {
  static override description =
    'Revoke an API key by id. The record stays on disk so old audit entries still reference a real id, but the daemon refuses to authenticate the key from this point forward.';

  static override args = {
    id: Args.string({description: 'API key id (8 hex chars)', required: true}),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(DaemonKeyRevoke);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const store = new ApiKeyStore();
    const updated = store.revoke(args.id);
    if (!updated) {
      this.outputError('INVALID_INPUT', `no API key with id "${args.id}" in ${store.directory}`);
      this.exit(2);
      return;
    }

    if (this.outputFormat === 'json') {
      this.outputSuccess({
        id: updated.id,
        label: updated.label,
        revokedAt: updated.revokedAt,
      });
      return;
    }

    this.log(`Revoked API key ${updated.id} (${updated.label}) at ${updated.revokedAt}.`);
  }
}
