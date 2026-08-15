// Moving a pre-seed reference between machines.
//
// Building one IS the chain walk — tens of minutes, once per network per
// machine. That cost is identical for everyone, because the reference holds
// public chain state and nothing else, so it is work that should be done once
// and shared rather than repeated by every developer who clones the repo.
//
// The on-disk shape is the same one `scripts/export-preseed.mjs` writes into the
// extension package and CI publishes: gzipped state per sub-wallet plus a
// manifest. Keeping the two identical means a reference exported here can be
// dropped straight into the extension, and one downloaded from a release can be
// imported here — one format, not two that drift.

import { gzipSync, gunzipSync } from 'node:zlib';
import {
  emptyRefHeightKey,
  emptyRefStateKey,
  type SyncStateStore,
  type WalletPart,
} from './sync-store.js';

/** The sub-wallets a reference carries. Order is fixed for stable manifests. */
export const REFERENCE_PARTS: readonly WalletPart[] = ['shielded', 'unshielded', 'dust'] as const;

export interface ReferenceManifest {
  network: string;
  height: number;
  parts: Record<string, { bytes: number; gzipBytes: number }>;
}

/** A reference in transit: the manifest plus each part's gzipped bytes. */
export interface PortableReference {
  manifest: ReferenceManifest;
  files: Map<string, Uint8Array>;
}

/**
 * Read this machine's reference for `networkId` into a portable bundle.
 *
 * The reference wallet's MNEMONIC is deliberately not included. It is the one
 * secret in the whole arrangement: anyone holding it controls the wallet the
 * reference was built from, and a published reference is meant to be safe to
 * hand to strangers. The state blobs are public chain data; the mnemonic is not,
 * and there is no reason for a consumer to have it — importing reconstructs
 * nothing from it.
 *
 * Returns null when there is no usable reference, rather than an empty bundle
 * that would import as a valid-looking reference at height 0.
 */
export async function exportReference(
  store: SyncStateStore,
  networkId: string,
): Promise<PortableReference | null> {
  const heightRaw = (await store.get(emptyRefHeightKey(networkId)))?.trim();
  const height = heightRaw ? Number(heightRaw) : NaN;
  if (!Number.isFinite(height) || height <= 0) return null;

  const files = new Map<string, Uint8Array>();
  const parts: ReferenceManifest['parts'] = {};

  for (const part of REFERENCE_PARTS) {
    const value = await store.get(emptyRefStateKey(networkId, part));
    if (value === null || value === undefined) continue;
    const raw = Buffer.from(value, 'utf8');
    const gz = gzipSync(raw);
    files.set(`${part}.dat.gz`, new Uint8Array(gz));
    parts[part] = { bytes: raw.byteLength, gzipBytes: gz.byteLength };
  }

  // A reference whose dust state is missing is not a reference: dust is the
  // part that takes an hour to build and the only reason this exists.
  if (!files.has('dust.dat.gz')) return null;

  return { manifest: { network: networkId, height, parts }, files };
}

export class ReferenceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceImportError';
  }
}

/**
 * Write a bundle into this machine's store as the reference for its network.
 *
 * Refuses rather than guesses:
 *
 * - a bundle for another network would seed wallets from a chain they have
 *   never been on, and the mismatch is silent afterwards
 * - a bundle older than what is already here is a downgrade, and downgrading a
 *   reference costs catch-up time on every wallet created from then on
 *
 * `force` overrides the second, because re-importing a known-good older bundle
 * to replace a corrupt newer one is a real thing to want.
 */
export async function importReference(
  store: SyncStateStore,
  networkId: string,
  bundle: PortableReference,
  opts: { force?: boolean } = {},
): Promise<{ height: number; replacedHeight: number | null }> {
  if (bundle.manifest.network !== networkId) {
    throw new ReferenceImportError(
      `Bundle is for ${bundle.manifest.network}, not ${networkId}. Importing it would seed wallets from the wrong chain.`,
    );
  }
  if (!Number.isFinite(bundle.manifest.height) || bundle.manifest.height <= 0) {
    throw new ReferenceImportError(`Bundle declares an unusable height (${bundle.manifest.height}).`);
  }
  if (!bundle.files.has('dust.dat.gz')) {
    throw new ReferenceImportError('Bundle has no dust state — that is the part a reference exists for.');
  }

  const existingRaw = (await store.get(emptyRefHeightKey(networkId)))?.trim();
  const existing = existingRaw ? Number(existingRaw) : NaN;
  const replacedHeight = Number.isFinite(existing) && existing > 0 ? existing : null;

  if (replacedHeight !== null && bundle.manifest.height < replacedHeight && !opts.force) {
    throw new ReferenceImportError(
      `Refusing to go backwards: this machine has height ${replacedHeight}, the bundle is ${bundle.manifest.height}. Pass --force to import it anyway.`,
    );
  }

  // Decompress EVERYTHING before writing ANYTHING. Unpacking as we go left the
  // store holding new shielded/unshielded state beside an old dust state when a
  // later part turned out to be corrupt — a mixture that never existed on chain
  // and that nothing downstream would flag, because the height key still looked
  // consistent.
  const decoded: Array<[WalletPart, string]> = [];
  for (const part of REFERENCE_PARTS) {
    const gz = bundle.files.get(`${part}.dat.gz`);
    if (!gz) continue;
    try {
      decoded.push([part, gunzipSync(Buffer.from(gz)).toString('utf8')]);
    } catch (err) {
      throw new ReferenceImportError(`${part}.dat.gz is not valid gzip: ${String(err)}`);
    }
  }

  // Parts first, height last. The height key is what `preseedReferenceStatus`
  // and the seeding guard read to decide a reference is usable, so writing it
  // before the state it describes would advertise a reference that is still
  // being unpacked — and a process killed midway would leave exactly that.
  for (const [part, json] of decoded) {
    await store.put(emptyRefStateKey(networkId, part), json);
  }
  await store.put(emptyRefHeightKey(networkId), String(bundle.manifest.height));

  return { height: bundle.manifest.height, replacedHeight };
}
