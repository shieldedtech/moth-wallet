import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';

export default class WalletUse extends BaseCommand {
  static override description = 'Switch active wallet';

  static override args = {
    name: Args.string({ description: 'Wallet name', required: false }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(WalletUse);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const name = await this.promptIfMissing(args.name, 'Wallet name');
    await this.walletManager.setActive(name);
    this.outputSuccess({ active: name });
  }
}
