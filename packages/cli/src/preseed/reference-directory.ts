import {existsSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {REFERENCE_FILE_NAMES, type PortableReference, type ReferenceManifest} from '@shieldedtech/moth-wallet';

export class ReferenceDirectoryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ReferenceDirectoryError';
  }
}

/**
 * Read a pre-seed bundle directory into the shape `importReference` takes.
 *
 * Accepts both a `preseed export` directory and an extension `preseed/<network>/`
 * directory, and loads every file a bundle may carry — witnesses as well as
 * state. `preseed import` used to list the three `.dat.gz` parts itself, so the
 * witnesses in either kind of directory never reached the import: every imported
 * reference was unverifiable, and one cut before an indexer renumbering imported
 * cleanly and then failed its sync in a loop instead of being refused.
 */
export function readReferenceDirectory(dir: string): PortableReference {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new ReferenceDirectoryError(
      `No manifest.json in ${dir}.`,
      'Point this at a directory produced by `preseed export`, or an extension preseed/<network>/ directory.',
    );
  }

  let manifest: ReferenceManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReferenceManifest;
  } catch (err) {
    throw new ReferenceDirectoryError(`manifest.json is not readable JSON: ${String(err)}`);
  }

  const files = new Map<string, Uint8Array>();
  for (const name of REFERENCE_FILE_NAMES) {
    const at = join(dir, name);
    if (existsSync(at) && statSync(at).isFile()) {
      files.set(name, new Uint8Array(readFileSync(at)));
    }
  }

  return {manifest, files};
}
