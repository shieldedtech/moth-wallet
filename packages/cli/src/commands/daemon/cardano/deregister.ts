// Stop DUST generation from this wallet's cNIGHT, through the running
// daemon. Reverses `daemon cardano register`: burns the registration token
// and rotates every cNIGHT UTXO so nothing keeps generating under the old
// mapping.

import {Flags} from '@oclif/core';
import {BaseCommand, daemonClientFlags} from '../../../base-command.js';

export default class DaemonCardanoDeregister extends BaseCommand {
  static override description =
    "Stop DUST generation from this wallet's cNIGHT via the running daemon.";

  static override flags = {
    ...BaseCommand.baseFlags,
    ...daemonClientFlags,
    'timeout-ms': Flags.integer({
      description: 'Override the RPC timeout (default: 300000)',
      default: 300_000,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonCardanoDeregister);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    const client = await this.connectDaemonOrExit(network.id, walletName, {bind: flags.bind});
    if (!client) return;

    try {
      const result = await client.call<{txHash: string; cleared: number}>('cardanoDeregister', null, {
        timeoutMs: flags['timeout-ms'],
      });
      if (this.outputFormat === 'json') {
        this.outputSuccess(result);
      } else {
        this.log(
          `Deregistered on Cardano (${result.cleared} registration${result.cleared === 1 ? '' : 's'} cleared). `
            + `Transaction: ${result.txHash}`,
        );
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
