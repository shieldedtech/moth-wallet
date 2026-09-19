import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { exportReference, resolveSyncStore } from '@shieldedtech/moth-wallet';

/**
 * Write this machine's reference out as a portable directory.
 *
 * What makes one machine's hour every other machine's seconds — including CI,
 * where a persistent per-network cache plus `preseed refresh` costs seconds per
 * run.
 */
export default class PreseedExport extends BaseCommand {
  static override description = 'Write this machine\'s pre-seed reference to a directory';

  static override examples = ['<%= config.bin %> preseed export ./ref --network preprod'];

  static override args = {
    path: Args.string({ description: 'Directory to write the reference into', required: true }),
  };

  static override flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PreseedExport);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const bundle = await exportReference(await resolveSyncStore(), network.id);
    if (!bundle) {
      this.outputError(
        'WALLET_ERROR',
        `No usable reference for ${network.id} to export.`,
        'Import or build one first.',
      );
      this.exit(1);
      return;
    }

    mkdirSync(args.path, { recursive: true });
    for (const [name, bytes] of bundle.files) {
      writeFileSync(join(args.path, name), bytes);
    }
    writeFileSync(join(args.path, 'manifest.json'), `${JSON.stringify(bundle.manifest, null, 2)}\n`);

    this.outputSuccess({
      network: network.id,
      height: bundle.manifest.height,
      directory: args.path,
      files: [...bundle.files.keys(), 'manifest.json'],
      // Said out loud because the whole point of exporting is to hand it to
      // someone, and people are right to ask what they are handing over.
      note: 'State only — the reference wallet mnemonic is never exported.',
    });
  }
}
