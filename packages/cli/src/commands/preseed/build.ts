import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { warmEmptyRefCache } from '@shieldedtech/moth-wallet';

/**
 * Build a reference from scratch by syncing an empty wallet to chain tip.
 *
 * The slow one, and the last resort: prefer `preseed import` when a reference
 * exists to import, since it is the same serialized state for seconds instead of
 * tens of minutes. Deliberately a command rather than something that happens on
 * startup — a first build IS the chain walk, paid once per network per machine,
 * and the wallet's own startup path must never block on it (see the comment on
 * `ensureEmptyRefCache`, which is why that function does not build by default).
 */
export default class PreseedBuild extends BaseCommand {
  static override description = 'Build a pre-seed reference from genesis (slow — prefer `preseed import`)';

  static override examples = [
    '<%= config.bin %> preseed build --network preview',
    '<%= config.bin %> preseed build --network preprod --timeout 180',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    timeout: Flags.integer({
      description: 'Minutes to allow the build before giving up',
      default: 120,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedBuild);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Says so before starting, because an unattended command that appears to
    // hang for an hour is indistinguishable from a broken one.
    process.stderr.write(
      `Building the ${network.id} reference from genesis. This walks the whole chain — ` +
        `tens of minutes, and it resumes if interrupted.\n`,
    );

    const started = Date.now();
    const states = await warmEmptyRefCache(
      network,
      (msg) => this.log_verbose(msg),
      undefined,
      (p) => {
        if (p.total > 0 && p.applied % 50_000 === 0) {
          process.stderr.write(`  ${p.applied}/${p.total} dust events\n`);
        }
      },
    );
    const minutes = Math.round((Date.now() - started) / 60_000);

    if (!states) {
      this.outputError(
        'WALLET_ERROR',
        `Reference build for ${network.id} did not reach chain tip after ${minutes} min.`,
        'Progress is saved — run the command again to resume.',
      );
      this.exit(1);
      return;
    }

    this.outputSuccess({ network: network.id, height: states.height, minutes });
  }
}
