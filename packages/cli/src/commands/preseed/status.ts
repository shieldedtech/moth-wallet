import { BaseCommand } from '../../base-command.js';
import { archivedReferenceHeights, chainTip, preseedReferenceStatus } from '@shieldedtech/moth-wallet';

/**
 * Show which pre-seed references this machine holds.
 *
 * A reference is one empty wallet synced to a height. Wallets whose birthday is
 * at or above it start from its state instead of walking the chain — 78.6 min of
 * DUST sync becomes 29.3s on preprod. Worth its own command because the failure
 * mode is silent: a wallet whose birthday sits below every reference syncs from
 * genesis while reporting nothing wrong. Listing the heights makes "no reference
 * covers you" legible.
 */
export default class PreseedStatus extends BaseCommand {
  static override description = 'Show the pre-seed references held for a network';

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
    const [live, archived] = await Promise.all([
      preseedReferenceStatus(network),
      archivedReferenceHeights(network),
    ]);

    // Tip is informational, and the chain being unreachable must not turn a
    // local-cache question into an error.
    let tip: number | null = null;
    try {
      tip = (await chainTip(network.indexerUrl))?.height ?? null;
    } catch {
      tip = null;
    }

    // The lowest archived reference is the earliest birthday that can seed:
    // anything below it has no reference holding its history.
    const earliestSeedableBirthday = archived.length > 0 ? archived[archived.length - 1] : live.height;

    this.outputSuccess({
      network: network.id,
      tip,
      liveReferenceHeight: live.height,
      ready: live.ready,
      archivedHeights: archived,
      earliestSeedableBirthday,
      // Says what the heights above mean for the next wallet, which is the
      // question anyone running this actually has.
      message: live.ready
        ? `Reference at height ${live.height}. A wallet with a birthday at or above ` +
          `${earliestSeedableBirthday ?? live.height} starts from a reference; anything earlier syncs from genesis.`
        : 'No usable reference for this network. Import one with `preseed import`, or build one with `preseed build`.',
    });
  }
}
