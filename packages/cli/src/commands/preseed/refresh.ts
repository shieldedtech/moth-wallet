import { BaseCommand } from '../../base-command.js';
import { preseedReferenceStatus, refreshEmptyRefCache } from '@shieldedtech/moth-wallet';

/**
 * Advance an existing reference to the current chain tip.
 *
 * Catches one up rather than rebuilding it: measured at 9.1s to advance 25,660
 * blocks, against 53.6 min to rebuild the same reference from genesis — which is
 * what this command exists to stop anyone doing by hand.
 */
export default class PreseedRefresh extends BaseCommand {
  static override description = 'Advance this machine\'s pre-seed reference to the chain tip';

  static override examples = ['<%= config.bin %> preseed refresh --network preprod'];

  static override flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedRefresh);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const before = await preseedReferenceStatus(network);
    if (!before.ready) {
      this.outputError(
        'WALLET_ERROR',
        `No reference to refresh for ${network.id}.`,
        'Import one with `preseed import`, or build one with `preseed build`.',
      );
      this.exit(1);
      return;
    }

    const started = Date.now();
    await refreshEmptyRefCache(network, (msg) => this.log_verbose(msg));
    const after = await preseedReferenceStatus(network);

    this.outputSuccess({
      network: network.id,
      heightBefore: before.height,
      heightAfter: after.height,
      advancedBlocks: (after.height ?? 0) - (before.height ?? 0),
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }
}
