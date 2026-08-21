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

import {
  emptyRefHeightKey,
  emptyRefStateKey,
  type SyncStateStore,
  type WalletPart,
} from './sync-store.js';

// Compression goes through the Web Streams API rather than `node:zlib`, because
// this module lives in `core` and `core` must import no platform builtin — one
// careless barrel import would drag Node's zlib into every DApp bundle that
// depends on the browser package. CompressionStream is in Node 18+ and every
// current browser, so the same code serves both. The trade is that gzip level is
// not selectable, so bundles written here compress slightly less than
// `scripts/export-preseed.mjs` (which is Node-only and keeps level 9); size is
// recorded in the manifest either way, and decompression is level-agnostic.
/**
 * One-chunk stream over `bytes`, so no Blob is needed to feed a transform.
 *
 * The copy into a fresh ArrayBuffer is what makes the types line up: a
 * `Uint8Array` may be backed by a SharedArrayBuffer, which `BufferSource` does
 * not accept, and TypeScript cannot know which this one is. Copying is cheap
 * relative to gzipping the same bytes, and only happens on export/import.
 */
function streamOf(bytes: Uint8Array): ReadableStream<BufferSource> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(owned);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new CompressionStream('gzip')));
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')));
}

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

  const encoder = new TextEncoder();
  for (const part of REFERENCE_PARTS) {
    const value = await store.get(emptyRefStateKey(networkId, part));
    // All three or nothing. Skipping a missing part used to export a bundle that
    // importing would apply OVER an existing reference, leaving the store with
    // two parts at the new height and one at the old — a mixture that never
    // existed on chain, while the height key still looked consistent. Dust alone
    // was checked, but the same hole is reachable through any part.
    if (value === null || value === undefined) return null;
    const raw = encoder.encode(value);
    const gz = await gzip(raw);
    files.set(`${part}.dat.gz`, gz);
    parts[part] = { bytes: raw.byteLength, gzipBytes: gz.byteLength };
  }

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
  // Every part, not just dust. A bundle missing one part would be applied over
  // the reference already here, leaving the store mixing heights with a height
  // key that still reads as consistent — and that inflated height then feeds the
  // `emptyRef.height <= birthday` guard, seeding wallets whose birthday falls
  // between the two.
  const missing = REFERENCE_PARTS.filter((part) => !bundle.files.has(`${part}.dat.gz`));
  if (missing.length > 0) {
    throw new ReferenceImportError(
      `Bundle is missing ${missing.map((part) => `${part}.dat.gz`).join(', ')}. ` +
        'A reference is all three sub-wallets at one height; importing part of one would mix heights.',
    );
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
  const decoder = new TextDecoder();
  for (const part of REFERENCE_PARTS) {
    // Present by the check above, so a miss here is a logic error, not input.
    const gz = bundle.files.get(`${part}.dat.gz`) as Uint8Array;
    try {
      decoded.push([part, decoder.decode(await gunzip(gz))]);
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
