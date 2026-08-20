import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { archivedReferenceHeights, preseedReferenceStatus, warmEmptyRefCache } from '@shieldedtech/moth-wallet';

/**
 * Build a pre-seed reference for this network, then archive it at its height.
 *
 * Deliberately a command and not something a wallet does on startup: building
 * means syncing an empty wallet to chain tip, and DUST makes that a
 * tens-of-minutes job. Running it periodically is what keeps the archive dense
 * enough for a later import to seed from rather than walk the chain.
 */
export default class PreseedBuild extends BaseCommand {
  static override description = 'Build and archive a pre-seed reference at the current chain tip';

  static override examples = [
    '<%= config.bin %> preseed build --network preprod',
    '<%= config.bin %> preseed build --network preprod --force',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description: 'Rebuild even when a reference already exists at or near tip',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedBuild);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const before = await preseedReferenceStatus(network);

    if (before.ready && !flags.force) {
      this.outputSuccess({
        built: false,
        reason: 'a reference already exists for this network — pass --force to build another',
        liveReferenceHeight: before.height,
        archivedHeights: await archivedReferenceHeights(network),
      });
      return;
    }

    if (this.outputFormat === 'text') {
      this.log(`Building a pre-seed reference for ${network.id}. This syncs an empty wallet to tip`);
      this.log('and can take tens of minutes — DUST is the slow part. Progress follows.');
    }

    // Progress goes to stderr-style logging only in text mode: JSON consumers get
    // one object at the end, not a stream they would have to parse around.
    const states = await warmEmptyRefCache(network, (msg) => {
      if (this.outputFormat === 'text') this.log(`  ${msg}`);
    });

    if (!states) {
      this.outputError(
        'TIMEOUT',
        'Reference build did not complete. Partial progress is saved, so running this again resumes rather than restarting.',
      );
      this.exit(1);
      return;
    }

    this.outputSuccess({
      built: true,
      referenceHeight: states.height,
      archivedHeights: await archivedReferenceHeights(network),
    });
  }
}
