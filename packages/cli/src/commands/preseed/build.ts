import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  archivedReferenceHeights,
  preseedReferenceStatus,
  refreshEmptyRefCache,
  warmEmptyRefCache,
} from '@shieldedtech/moth-wallet';

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
    // --force MUST take the refresh path, not the warm one. warmEmptyRefCache is
    // ensureEmptyRefCache(build: true), which returns any reference already in the
    // store before it ever reaches the builder — so with a live reference present
    // this returned in seconds and reported success at the unchanged height while
    // printing none of the sync it claimed to have done. That made the archive
    // unreachable from the CLI, since a second height can only be gained by
    // advancing the live one. refreshEmptyRefCache drops the memo and calls the
    // builder directly, resuming from cached state rather than walking genesis.
    const advance = flags.force ? refreshEmptyRefCache : warmEmptyRefCache;
    const startedAt = Date.now();
    const states = await advance(network, (msg) => {
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

    // Say so when nothing moved. Reporting built: true at an unchanged height is
    // how this stayed invisible to anyone running the command on a schedule.
    const advanced = (before.height ?? 0) < states.height;
    this.outputSuccess({
      built: advanced,
      referenceHeight: states.height,
      previousHeight: before.height,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      archivedHeights: await archivedReferenceHeights(network),
      ...(advanced ? {} : {reason: 'the reference was already at this height — nothing to advance'}),
    });
  }
}
