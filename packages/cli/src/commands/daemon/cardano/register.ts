// Register the wallet's cNIGHT for DUST generation through the running
// daemon. The daemon builds, signs and submits the Cardano transaction;
// the mnemonic never leaves it. Triggers an L3 confirmation modal naming
// the DUST receiver and warning when it is not this wallet.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

interface RegisterResult {
  txHash: string;
  receiver: string;
}

export default class DaemonCardanoRegister extends BaseCommand {
  static override description =
    "Register this wallet's cNIGHT for DUST generation via the running daemon.";

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    receiver: Flags.string({
      description:
        "Midnight DUST address (mn_dust_…) or its 66-hex serialization (default: this wallet's own)",
    }),
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonCardanoRegister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const result = await client.call<RegisterResult>(
        'cardanoRegister',
        {receiver: flags.receiver},
        {timeoutMs: flags['timeout-ms']},
      );
      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(`Registered on Cardano. Transaction: ${result.txHash}`);
        this.log('DUST generation starts once the Midnight indexer observes it.');
      }
    } catch (err) {
      const {category, message} = this.renderDaemonError(err);
      this.outputError(category, message);
      this.exit(1);
      return;
    } finally {
      client.close();
    }
  }
}
