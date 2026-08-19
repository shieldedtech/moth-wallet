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
      wallets.map(
        (w: {
          name: string;
          address: string;
          network: string;
          active: boolean;
          signatureKind?: 'schnorr' | 'ecdsa';
        }) => ({
        name: w.name,
        address: w.address,
        network: w.network,
        // Only shown when it is not the default: an ECDSA wallet has a
        // different unshielded address and works on v9 networks only, so
        // knowing which is which matters. Blank for the schnorr majority.
        signing: w.signatureKind === 'ecdsa' ? 'ecdsa' : '',
        active: w.active ? '→' : '',
      }),
      ),
    );
  }
}
