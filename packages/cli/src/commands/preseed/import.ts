import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  importReference,
  ReferenceImportError,
  resolveSyncStore,
  type PortableReference,
  type ReferenceManifest,
} from '@shieldedtech/moth-wallet';

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
    const dir = args.path;
    const manifestPath = join(dir, 'manifest.json');

    if (!existsSync(manifestPath)) {
      this.outputError(
        'INVALID_INPUT',
        `No manifest.json in ${dir}.`,
        'Point this at a directory produced by `preseed export`, or an extension preseed/<network>/ directory.',
      );
      this.exit(1);
      return;
    }

    let manifest: ReferenceManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReferenceManifest;
    } catch (err) {
      this.outputError('INVALID_INPUT', `manifest.json is not readable JSON: ${String(err)}`);
      this.exit(1);
      return;
    }

    const files = new Map<string, Uint8Array>();
    for (const name of ['shielded.dat.gz', 'unshielded.dat.gz', 'dust.dat.gz']) {
      const at = join(dir, name);
      if (existsSync(at) && statSync(at).isFile()) {
        files.set(basename(at), new Uint8Array(readFileSync(at)));
      }
    }

    const bundle: PortableReference = { manifest, files };
    try {
      const result = await importReference(await resolveSyncStore(), network.id, bundle, {
        force: flags.force,
      });
      this.outputSuccess({
        network: network.id,
        height: result.height,
        replacedHeight: result.replacedHeight,
        message:
          result.replacedHeight === null
            ? `Imported a reference at height ${result.height}. Wallets created from now on start there.`
            : `Replaced height ${result.replacedHeight} with ${result.height}.`,
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
