import { BaseCommand } from '../../base-command.js';
import { IndexerClient } from '@shieldedtech/moth-wallet';

export default class DustStatus extends BaseCommand {
  static override description = 'Show DUST generation status';

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const wallets = await this.walletManager.list();
    const wallet = wallets.find((w: { name: string }) => w.name === walletName);

    if (!wallet) {
      this.outputError('WALLET_ERROR', `Wallet "${walletName}" not found`);
      this.exit(1);
      return;
    }

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const client = new IndexerClient(network.indexerUrl);

    // Query DUST status — requires the Cardano reward address
    // For now, use the wallet address as a placeholder
    const statuses = await client.getDustGenerationStatus([wallet.address]);

    if (statuses.length === 0) {
      this.outputSuccess({
        registered: false,
        dustAddress: null,
        nightBalance: '0',
        generationRate: '0',
        maxCapacity: '0',
        currentCapacity: '0',
      });
      return;
    }

    const status = statuses[0];
    this.outputSuccess({
      registered: status.registered,
      dustAddress: status.dustAddress,
      nightBalance: status.nightBalance,
      generationRate: status.generationRate,
      maxCapacity: status.maxCapacity,
      currentCapacity: status.currentCapacity,
    });
  }
}
