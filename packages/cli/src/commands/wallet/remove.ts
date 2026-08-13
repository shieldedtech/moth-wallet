import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class WalletRemove extends BaseCommand {
  static override description = 'Remove a wallet (requires confirmation or --yes)';

  static override args = {
    name: Args.string({ description: 'Wallet name', required: false }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({ default: false, description: 'Skip confirmation' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WalletRemove);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const name = await this.promptIfMissing(args.name, 'Wallet name to remove');

    // Require explicit --yes for non-interactive deletion (prevents accidental deletion in CI)
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        throw new (await import('@shieldedtech/moth-wallet')).WalletError(
          'INVALID_INPUT',
          'Non-interactive wallet deletion requires --yes flag',
        );
      }
      const confirm = await this.promptIfMissing(undefined, `Remove wallet "${name}"? (yes/no)`);
      if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        this.log('Cancelled.');
        return;
      }
    }

    await this.walletManager.remove(name);
    this.outputSuccess({ removed: name });
  }
}
