import { BaseCommand } from '../../base-command.js';

export default class WalletList extends BaseCommand {
  static override description = 'List all configured wallets';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletList);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';

    // Ask for addresses encoded for the network being worked with: the stored one
    // is from create/import time, so a wallet created on devnet and since used on
    // preprod would otherwise always be listed with its devnet address (#107).
    const network = flags.network;
    const wallets = await this.walletManager.list({network});

    if (wallets.length === 0) {
      this.log('No wallets configured. Run: moth wallet generate');
      return;
    }

    this.outputSuccess(
      wallets.map(
        (w: { name: string; address: string; addressNetwork?: string; network: string; active: boolean }) => ({
          name: w.name,
          address: w.address,
          // The address is for the network asked about; this column is where the
          // wallet started. They differ routinely and the old single `network`
          // column read as "the only network this wallet works on".
          'created on': w.network,
          'address for': w.addressNetwork ?? w.network,
          active: w.active ? '→' : '',
        }),
      ),
    );
  }
}
