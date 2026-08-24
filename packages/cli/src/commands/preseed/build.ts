import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  archivedReferenceHeights,
  buildDustReferenceAtHeight,
  dustReferenceHeights,
  preseedReferenceStatus,
  refreshEmptyRefCache,
  warmEmptyRefCache,
} from '@shieldedtech/moth-wallet';

/**
 * Build a pre-seed reference for this network, then archive it at its height.
 *
 * The slow one, and the last resort: prefer `preseed import` when a reference
 * exists to import, since it is the same serialized state for seconds instead of
 * tens of minutes. Deliberately a command rather than something that happens on
 * startup — a first build IS the chain walk, paid once per network per machine,
 * and the wallet's own startup path must never block on it (see the comment on
 * `ensureEmptyRefCache`, which is why that function does not build by default).
 *
 * Running it periodically is what keeps the archive dense enough for a later
 * import to seed from rather than walk the chain.
 */
export default class PreseedBuild extends BaseCommand {
  static override description = 'Build and archive a pre-seed reference at the current chain tip (slow — prefer `preseed import`)';

  static override examples = [
    '<%= config.bin %> preseed build --network preview',
    '<%= config.bin %> preseed build --network preprod --force',
    '<%= config.bin %> preseed build --network preprod --timeout 180',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description: 'Rebuild even when a reference already exists at or near tip',
      default: false,
    }),
    timeout: Flags.integer({
      description: 'Minutes to allow the build before giving up',
      default: 120,
    }),
    height: Flags.integer({
      description:
        'Build a DUST-ONLY reference that stops at this block instead of the current tip. ' +
        'This is what makes an OLDER account fast: every published reference is at tip, so an ' +
        'account whose history starts below them replays the whole dust stream. Pick a height at ' +
        'or below the account\'s first dust generation — `moth dust status` reports it. Shielded ' +
        'and unshielded are not included: they reach tip in seconds, and a reference claiming a ' +
        'height it does not hold is the one shape that loses funds.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedBuild);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // --height is a different build with a different product: one part, one
    // height, and no interaction with the live reference at tip.
    if (flags.height !== undefined) {
      if (flags.height <= 0) {
        this.outputError('INVALID_INPUT', `--height must be a positive block height, got ${flags.height}`);
        this.exit(1);
        return;
      }
      if (this.outputFormat === 'text') {
        this.log(`Building a DUST-only reference for ${network.id} at block ${flags.height}.`);
        this.log('This walks the dust stream from genesis to that point — tens of minutes, and it resumes if interrupted.');
      }
      const startedAt = Date.now();
      const built = await buildDustReferenceAtHeight(
        network,
        flags.height,
        (msg) => {
          if (this.outputFormat === 'text') this.log(`  ${msg}`);
        },
        undefined,
        {
          timeoutMs: flags.timeout * 60_000,
          onWarmProgress: (p) => {
            if (this.outputFormat === 'text' && p.total > 0 && p.applied % 50_000 === 0) {
              this.log(`  ${p.applied}/${p.total} dust events`);
            }
          },
        },
      );
      if (!built) {
        this.outputError(
          'WALLET_ERROR',
          `Could not build a dust reference for ${network.id} at block ${flags.height}.`,
          'Progress is saved — re-run to resume, or try a lower --height.',
        );
        this.exit(1);
        return;
      }
      this.outputSuccess({
        network: network.id,
        built: true,
        kind: 'dust-only',
        referenceHeight: built.height,
        dustCursor: built.cursor,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        dustReferenceHeights: await dustReferenceHeights(network),
        note:
          `Accounts whose first dust generation is at or above ${built.height} can now seed their ` +
          'dust from this instead of replaying the stream.',
      });
      return;
    }

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

    // Says so before starting, because an unattended command that appears to
    // hang for an hour is indistinguishable from a broken one.
    if (this.outputFormat === 'text') {
      this.log(`Building the ${network.id} reference. This syncs an empty wallet to tip —`);
      this.log('tens of minutes, DUST is the slow part, and it resumes if interrupted.');
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

    // --timeout was declared but never wired, so the flag and the two places
    // documenting it promised something that could not happen. The builder takes
    // no deadline of its own, so it is raced against one here. The build keeps
    // running in this process until exit, which is harmless: state is written as
    // it goes, so re-running resumes rather than restarts.
    const deadline = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), flags.timeout * 60_000).unref(),
    );
    const states = await Promise.race([
      advance(
        network,
        (msg) => {
          if (this.outputFormat === 'text') this.log(`  ${msg}`);
        },
        undefined,
        (p) => {
          if (this.outputFormat === 'text' && p.total > 0 && p.applied % 50_000 === 0) {
            this.log(`  ${p.applied}/${p.total} dust events`);
          }
        },
      ),
      deadline,
    ]);
    const minutes = Math.round((Date.now() - startedAt) / 60_000);

    if (!states) {
      this.outputError(
        'TIMEOUT',
        `Reference build for ${network.id} did not reach chain tip after ${minutes} min.`,
        'Partial progress is saved, so running this again resumes rather than restarting.',
      );
      this.exit(1);
      return;
    }

    // Say so when nothing moved. Reporting built: true at an unchanged height is
    // how this stayed invisible to anyone running the command on a schedule.
    const advanced = (before.height ?? 0) < states.height;
    this.outputSuccess({
      network: network.id,
      built: advanced,
      referenceHeight: states.height,
      previousHeight: before.height,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      minutes,
      archivedHeights: await archivedReferenceHeights(network),
      ...(advanced ? {} : {reason: 'the reference was already at this height — nothing to advance'}),
    });
  }
}
