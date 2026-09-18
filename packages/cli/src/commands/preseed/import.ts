import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  importReference,
  ReferenceImportError,
  resolveSyncStore,
  type PortableReference,
} from '@shieldedtech/moth-wallet';
import { readReferenceDirectory, ReferenceDirectoryError } from '../../preseed/reference-directory.js';

/**
 * Load a reference produced elsewhere.
 *
 * The route to prefer over `preseed build`: the same serialized state arrives in
 * seconds where a build walks the chain for tens of minutes. Accepts a directory
 * from `preseed export`, or the extension's committed `preseed/<network>/`.
 */
export default class PreseedImport extends BaseCommand {
  static override description = 'Load a pre-seed reference from a directory';

  static override examples = [
    '<%= config.bin %> preseed import ./ref --network preprod',
    '<%= config.bin %> preseed import packages/extension/public/preseed/preprod --network preprod',
  ];

  static override args = {
    path: Args.string({ description: 'Directory holding manifest.json and the parts', required: true }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description: 'Import a reference older than the one already here',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(PreseedImport);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    let bundle: PortableReference;
    try {
      bundle = readReferenceDirectory(args.path);
    } catch (err) {
      if (err instanceof ReferenceDirectoryError) {
        this.outputError('INVALID_INPUT', err.message, err.hint);
        this.exit(1);
        return;
      }
      throw err;
    }

    try {
      const result = await importReference(await resolveSyncStore(), network.id, bundle, {
        force: flags.force,
      });
      const dustNote = {
        collapsed: ' Its dust trees were collapsed on the way in, so wallets seeded from it restore in milliseconds.',
        'already-collapsed': '',
        'as-is': ' Its dust state could not be collapsed and was stored as it is; wallets seeded from it restore slower.',
      }[result.dust];
      this.outputSuccess({
        network: network.id,
        height: result.height,
        replacedHeight: result.replacedHeight,
        dust: result.dust,
        message:
          (result.replacedHeight === null
            ? `Imported a reference at height ${result.height}. Wallets created from now on start there.`
            : `Replaced height ${result.replacedHeight} with ${result.height}.`) + dustNote,
      });
    } catch (err) {
      if (err instanceof ReferenceImportError) {
        this.outputError('INVALID_INPUT', err.message);
        this.exit(1);
        return;
      }
      throw err;
    }
  }
}
