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
          createdAt?: string;
          createdAtHeight?: { network: string; height: number };
          birthday?: number;
        }) => ({
          name: w.name,
          address: w.address,
          network: w.network,
          // Date only: the table is already wide, and the time of day is never
          // the thing anyone is looking for here.
          created: w.createdAt ? w.createdAt.slice(0, 10) : '',
          // The height a sync can start from. Blank means "from genesis", which
          // is the difference between seconds and an hour on DUST.
          from: w.birthday !== undefined ? String(w.birthday) : 'genesis',
          active: w.active ? '→' : '',
        }),
      ),
    );
  }
}
