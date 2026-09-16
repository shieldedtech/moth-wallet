import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { getPassphrase } from '../../adapters/passphrase.js';
import { dedesignateFromDustWithKeys, startWalletSync } from '@shieldedtech/moth-wallet';

export default class DustDeregister extends BaseCommand {
  static override description = 'Deregister wallet from DUST generation';

  static override flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Skip confirmation prompt',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DustDeregister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const passphrase = await getPassphrase();
    const wallet = await this.walletManager.unlock(walletName, passphrase);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // SR-003: Confirm transaction
    await this.confirmTransaction({
      'Operation': 'Deregister from DUST generation',
      'Network': network.id,
      'Wallet': walletName,
    }, flags);

    process.stderr.write('Syncing wallet before deregistration...\n');
    const syncedWallet = await startWalletSync(wallet.walletKeys, network, (msg) => {
      this.log_verbose(msg);
    }, walletName, false, await this.syncBirthday(walletName, network.id));

    try {
      const txHash = await dedesignateFromDustWithKeys(
        syncedWallet.facade,
        wallet.walletKeys,
        network.id,
        (stage) => { process.stderr.write(`DUST deregister: ${stage}\n`); },
      );

      this.outputSuccess({
        status: 'deregistered',
        txHash,
        wallet: walletName,
        network: network.id,
      });
    } finally {
      await syncedWallet.stop();
      wallet.lock();
    }
  }
}
