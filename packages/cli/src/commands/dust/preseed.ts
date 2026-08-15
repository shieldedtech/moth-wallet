import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  preseedReferenceStatus,
  refreshEmptyRefCache,
  warmEmptyRefCache,
  exportReference,
  importReference,
  ReferenceImportError,
  resolveSyncStore,
  type PortableReference,
  type ReferenceManifest,
} from '@shieldedtech/moth-wallet';

/**
 * Inspect and maintain this machine's pre-seed reference.
 *
 * A reference is one empty wallet synced to chain tip. Wallets created after it
 * start from its state instead of walking the chain — 78.6 min of DUST sync
 * becomes 29.3s on preprod. The extension ships one for preprod inside its
 * package; the CLI and TUI have no equivalent, so on those surfaces the
 * reference has to be built or imported.
 *
 * Deliberately a command rather than something that happens on startup. A first
 * build IS the chain walk, paid once per network per machine, and the wallet's
 * own startup path must never block on it — see the comment on
 * `ensureEmptyRefCache`, which is why that function does not build by default.
 */
export default class DustPreseed extends BaseCommand {
  static override description = "Inspect or maintain this machine's pre-seed reference";

  static override examples = [
    '<%= config.bin %> dust preseed status',
    '<%= config.bin %> dust preseed refresh --network preprod',
    '<%= config.bin %> dust preseed build --network preview',
    '<%= config.bin %> dust preseed export ./ref --network preprod',
    '<%= config.bin %> dust preseed import ./ref --network preprod',
  ];

  static override args = {
    action: Args.string({
      description: 'status (default), refresh, build, export or import',
      options: ['status', 'refresh', 'build', 'export', 'import'],
      default: 'status',
      required: false,
    }),
    path: Args.string({
      description: 'Directory to write to (export) or read from (import)',
      required: false,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    timeout: Flags.integer({
      description: 'Minutes to allow a build before giving up (build only)',
      default: 120,
    }),
    force: Flags.boolean({
      description: 'Import a reference older than the one already here (import only)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DustPreseed);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    if (args.action === 'status') {
      const status = await preseedReferenceStatus(network);
      this.outputSuccess({
        network: network.id,
        ready: status.ready,
        height: status.height,
        message: status.ready
          ? `Reference at height ${status.height}. Wallets created from now on start there.`
          : 'No usable reference for this network. Run `dust preseed build` once, or import one.',
      });
      return;
    }

    if (args.action === 'export') {
      if (!args.path) {
        this.outputError('INVALID_INPUT', 'export needs a directory.', 'Try: dust preseed export ./ref');
        this.exit(1);
        return;
      }
      const bundle = await exportReference(await resolveSyncStore(), network.id);
      if (!bundle) {
        this.outputError(
          'WALLET_ERROR',
          `No usable reference for ${network.id} to export.`,
          'Run `dust preseed build` first.',
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
      return;
    }

    if (args.action === 'import') {
      if (!args.path) {
        this.outputError('INVALID_INPUT', 'import needs a directory.', 'Try: dust preseed import ./ref');
        this.exit(1);
        return;
      }
      const dir = args.path;
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        this.outputError(
          'INVALID_INPUT',
          `No manifest.json in ${dir}.`,
          'Point this at a directory produced by `dust preseed export`, or an extension preseed/<network>/ directory.',
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
      return;
    }

    if (args.action === 'refresh') {
      // Catch an existing reference up rather than rebuilding it. Measured at
      // 9.1s to advance 25,660 blocks, against 53.6 min to rebuild the same
      // reference from genesis — which is what this command exists to stop
      // anyone doing by hand.
      const before = await preseedReferenceStatus(network);
      if (!before.ready) {
        this.outputError(
          'WALLET_ERROR',
          `No reference to refresh for ${network.id}.`,
          'Run `dust preseed build` to create one first.',
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
      return;
    }

    // build — the slow one. Says so before starting, because an unattended
    // command that appears to hang for an hour is indistinguishable from a
    // broken one.
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
