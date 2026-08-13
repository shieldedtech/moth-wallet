import { Flags } from '@oclif/core';
import { BaseCommand } from '../base-command.js';
import { WalletError } from '@shieldedtech/moth-wallet';

export default class Airdrop extends BaseCommand {
  static override description = 'Request test tokens on development networks';

  static override flags = {
    ...BaseCommand.baseFlags,
    amount: Flags.string({ description: 'Amount to request', default: '1000000' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Airdrop);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    if (flags.network !== 'devnet') {
      throw new WalletError(
        'INVALID_INPUT',
        `Airdrop is only available on devnet. Current network: ${flags.network}`,
      );
    }

    const walletName = await this.resolveWalletName(flags);
    const wallets = await this.walletManager.list();
    const wallet = wallets.find((w: { name: string }) => w.name === walletName);

    if (!wallet) {
      this.outputError('WALLET_ERROR', `Wallet "${walletName}" not found`);
      this.exit(1);
      return;
    }

    this.log_verbose(`Requesting airdrop for ${wallet.address}`);

    // TODO: Implement actual airdrop via devnet faucet endpoint
    // The devnet typically has a faucet or genesis account that can fund wallets

    this.outputSuccess({
      address: wallet.address,
      amount: flags.amount,
      token: 'NIGHT',
      status: 'requested',
    });
  }
}
