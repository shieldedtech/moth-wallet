import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { archivedReferenceHeights, preseedReferenceStatus } from '@shieldedtech/moth-wallet';
import {
  archiveReference,
  emptyRefHeightKey,
  emptyRefStateKey,
} from '@shieldedtech/moth-wallet/sync/sync-store';
import { NodeSyncStateStore } from '@shieldedtech/moth-wallet/sync/node-sync-store';

const PARTS = ['shielded', 'unshielded', 'dust'] as const;

/**
 * Install the reference the repository already ships, instead of building one.
 *
 * The repo carries a reference per network for the extension to bundle
 * (`packages/extension/public/preseed/<network>/`), and the extension installs it
 * on first unlock. The CLI and TUI read a different store (`~/.moth`) and had no
 * way to use those files at all, so a fresh checkout's only route to a reference
 * was `preseed build` — an empty wallet synced to tip, tens of minutes of DUST.
 * The files are the same serialized state that build would produce, so importing
 * them takes seconds.
 */
export default class PreseedInstall extends BaseCommand {
  static override description = "Install the repository's packaged pre-seed reference into ~/.moth";

  static override examples = [
    '<%= config.bin %> preseed install --network preprod',
    '<%= config.bin %> preseed install --network preprod --force',
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      description: 'Overwrite a reference already in the store, even a newer one',
      default: false,
    }),
    from: Flags.string({
      description: 'Directory holding manifest.json and the .dat.gz parts (defaults to the packaged one)',
    }),
  };

  /** Where the packaged references live, relative to the built command. */
  private packagedDir(networkId: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/commands/preseed → repo root
    const repoRoot = join(here, '..', '..', '..', '..', '..');
    return join(repoRoot, 'packages/extension/public/preseed', networkId);
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(PreseedInstall);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const dir = flags.from ?? this.packagedDir(network.id);
    const manifestPath = join(dir, 'manifest.json');

    if (!existsSync(manifestPath)) {
      this.outputError(
        'INVALID_INPUT',
        `No packaged reference for ${network.id} at ${dir}. Only networks with a committed reference can be ` +
          'installed this way; build one instead with `moth preseed build`.',
      );
      this.exit(1);
      return;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {network?: string; height?: number};
    const height = manifest.height;
    if (typeof height !== 'number' || height <= 0) {
      this.outputError('INVALID_INPUT', `Packaged manifest at ${manifestPath} records no usable height`);
      this.exit(1);
      return;
    }
    if (manifest.network && manifest.network !== network.id) {
      this.outputError(
        'INVALID_INPUT',
        `That reference is for ${manifest.network}, not ${network.id}. A reference is network-specific.`,
      );
      this.exit(1);
      return;
    }

    const store = new NodeSyncStateStore();
    const before = await preseedReferenceStatus(network);

    // A locally built reference is at least as fresh as anything committed, so
    // it keeps the live slot unless the user insists.
    if (before.ready && !flags.force && (before.height ?? 0) >= height) {
      this.outputSuccess({
        installed: false,
        reason: `a reference at block ${before.height} is already installed, at or above the packaged one (${height}) — pass --force to replace it`,
        liveReferenceHeight: before.height,
        archivedHeights: await archivedReferenceHeights(network),
      });
      return;
    }

    // Archive whatever the live slot holds before overwriting it. The packaged
    // reference is usually NEWER, and a lower reference is exactly what an
    // account with an earlier birthday needs, so replacing without archiving
    // would throw away the coverage that matters most.
    if (before.ready && before.height) {
      const existing = await Promise.all(
        PARTS.map((part) => store.get(emptyRefStateKey(network.id, part))),
      );
      if (existing.every((value): value is string => typeof value === 'string' && value.length > 0)) {
        await archiveReference(store, network.id, before.height, {
          shielded: existing[0],
          unshielded: existing[1],
          dust: existing[2],
        });
      }
    }

    const states: Record<string, string> = {};
    for (const part of PARTS) {
      const file = join(dir, `${part}.dat.gz`);
      if (!existsSync(file)) {
        // All three or none: a partial reference is refused by the reader anyway.
        this.outputError('INVALID_INPUT', `Packaged reference is missing ${part}.dat.gz — refusing a partial install`);
        this.exit(1);
        return;
      }
      states[part] = gunzipSync(readFileSync(file)).toString('utf-8');
    }

    for (const part of PARTS) await store.put(emptyRefStateKey(network.id, part), states[part]);
    // Height last: a reference with no recorded height is treated as unusable,
    // so an interrupted install is ignored rather than half-trusted.
    await store.put(emptyRefHeightKey(network.id), String(height));
    // And keep it at its own height, so a later build does not take its coverage.
    await archiveReference(store, network.id, height, {
      shielded: states.shielded,
      unshielded: states.unshielded,
      dust: states.dust,
    });

    this.outputSuccess({
      installed: true,
      referenceHeight: height,
      archivedHeights: await archivedReferenceHeights(network),
      note: `Accounts whose birthday is at or above ${height} will pre-seed instead of scanning from genesis.`,
    });
  }
}
