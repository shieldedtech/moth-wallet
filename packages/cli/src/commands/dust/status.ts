import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { CardanoCommand, cardanoFlags } from '../../cardano-command.js';
import { IndexerClient } from '@shieldedtech/moth-wallet';
import { deriveCardanoAddresses } from '@shieldedtech/moth-wallet/cardano';

export default class DustStatus extends CardanoCommand {
  static override description = 'Show DUST generation status';

  static override flags = {
    ...BaseCommand.baseFlags,
    ...cardanoFlags,
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
    const cardanoConfig = await this.getCardanoConfig(flags.network, flags);

    // The indexer keys DUST generation by Cardano *reward* address. This used
    // to pass the wallet's Midnight address, which the indexer can never match,
    // so the command reported "not registered" for every wallet including
    // registered ones. Deriving the real reward address needs the passphrase —
    // the Cardano key is not part of the public wallet metadata.
    const passphrase = await getPassphrase();
    const account = await this.getCardanoAccount(walletName, flags);
    const { mnemonic, accountIndex } = await this.resolveAccountKey(walletName, passphrase, account);
    const { rewardAddress } = await deriveCardanoAddresses(mnemonic, cardanoConfig, accountIndex);

    const client = new IndexerClient(network.indexerUrl);
    const statuses = await client.getDustGenerationStatus([rewardAddress]);

    if (statuses.length === 0) {
      this.outputSuccess({
        account: account.label,
        rewardAddress,
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
      account: account.label,
      rewardAddress,
      registered: status.registered,
      dustAddress: status.dustAddress,
      nightBalance: status.nightBalance,
      generationRate: status.generationRate,
      maxCapacity: status.maxCapacity,
      currentCapacity: status.currentCapacity,
    });
  }
}
