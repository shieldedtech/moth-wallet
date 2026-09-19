import { BaseCommand } from '../../base-command.js';
import { preseedReferenceStatus } from '@shieldedtech/moth-wallet';

/**
 * Report whether this machine holds a usable pre-seed reference.
 *
 * A reference is one empty wallet synced to chain tip. Wallets created after it
 * start from its state instead of walking the chain — 78.6 min of DUST sync
 * becomes 29.3s on preprod. Worth its own command because the absence is silent:
 * a wallet with no reference to use just syncs slowly.
 */
export default class PreseedStatus extends BaseCommand {
  static override description = "Show this machine's pre-seed reference for a network";

  static override examples = [
    '<%= config.bin %> preseed status',
    '<%= config.bin %> preseed status --network preprod',
  ];

  static override flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedStatus);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const status = await preseedReferenceStatus(network);

    this.outputSuccess({
      network: network.id,
      ready: status.ready,
      height: status.height,
      message: status.ready
        ? `Reference at height ${status.height}. Wallets created from now on start there.`
        : 'No usable reference for this network. Import one with `preseed import`, or build one with `preseed build`.',
    });
  }
}
