import { BaseCommand } from '../../base-command.js';

export default class WalletList extends BaseCommand {
  static override description = 'List all configured wallets';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletList);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    const wallets = await this.walletManager.list();

    if (wallets.length === 0) {
      this.log('No wallets configured. Run: moth wallet generate');
      return;
    }

    this.outputSuccess(
      wallets.map((w: { name: string; address: string; network: string; active: boolean }) => ({
        name: w.name,
        address: w.address,
        network: w.network,
        active: w.active ? '→' : '',
      })),
    );
  }
}
