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

import {isCursorWitness, type CursorWitness} from './cursor-witness.js';
import {collapseDustReference} from './dust-reference-collapse.js';
import {
  cursorWitnessKey,
  emptyRefCollapsedKey,
  emptyRefHeightKey,
  emptyRefStateKey,
  EMPTY_REF_WALLET,
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

/**
 * The parts a cursor witness exists for — the two whose streams are
 * indexer-numbered, matching what preseed.ts records and re-checks. Unshielded
 * cursors are transaction ids, which renumbering does not move.
 */
const WITNESSED_PARTS: readonly ('shielded' | 'dust')[] = ['shielded', 'dust'] as const;

/** The indexer stream each witnessed part's cursor numbers into. */
const WITNESS_STREAM: Record<'shielded' | 'dust', CursorWitness['stream']> = {
  shielded: 'zswapLedgerEvents',
  dust: 'dustLedgerEvents',
};

const witnessFileName = (part: WalletPart): string => `witness-${part}.json`;

/**
 * Every file a bundle may carry beside its manifest.
 *
 * Exported for whatever reads a bundle off disk, so it loads the witnesses along
 * with the state. The CLI's `preseed import` once listed the three `.dat.gz`
 * parts by hand and nothing else, which quietly dropped every witness a bundle
 * carried: imported references were all unverifiable, and one cut before a
 * renumbering imported cleanly and then failed its sync in a loop instead of
 * being refused.
 */
export const REFERENCE_FILE_NAMES: readonly string[] = [
  ...REFERENCE_PARTS.map((part) => `${part}.dat.gz`),
  ...WITNESSED_PARTS.map(witnessFileName),
];

export interface ReferenceManifest {
  network: string;
  height: number;
  parts: Record<string, { bytes: number; gzipBytes: number }>;
  /**
   * The cursor witnesses a bundle carries.
   *
   * A witness proves that the event a cursor names is still the same event. That
   * question is only answerable with the witness recorded where the reference was
   * BUILT: comparing it against the importing machine's indexer is the whole
   * check. So a bundle without witnesses describes a reference whose cursors
   * cannot be verified here — which matters most for a bundle, since crossing
   * machines is exactly how a reference meets a differently-numbered indexer.
   *
   * Two shapes, one per writer, and a bundle carries one of them:
   *
   * - a list of part names, each witness travelling as `witness-<part>.json`,
   *   which is what `exportReference` writes
   * - the witnesses themselves keyed by part, which is what
   *   `scripts/export-preseed.mjs` writes into the extension's committed bundles
   *
   * Optional: bundles cut before witnesses existed do not have it.
   */
  witnesses?: readonly string[] | Readonly<Record<string, CursorWitness>>;
}

/** A reference in transit: the manifest plus each part's gzipped bytes. */
export interface PortableReference {
  manifest: ReferenceManifest;
  files: Map<string, Uint8Array>;
}

/** What import did with the dust state a bundle carried. */
export type DustImportOutcome =
  /** Collapsed on the way in: the bundle was cut before references were collapsed. */
  | 'collapsed'
  /** Stored as given, because it was already collapsed. */
  | 'already-collapsed'
  /** Stored as given, because it could not be collapsed: restores slower, still correct. */
  | 'as-is';

/**
 * The dust state with its trees collapsed, where that can be done and verified.
 *
 * Best-effort on these paths: a state that cannot be collapsed is still a correct
 * one, just slower to restore, and refusing it would cost a whole reference. The
 * export script, which cuts the bundles the extension ships, is where a failure
 * is fatal instead. See dust-reference-collapse.ts.
 */
function collapsedIfPossible(dust: string): {json: string; outcome: DustImportOutcome} {
  try {
    const {json, report} = collapseDustReference(dust);
    return {json, outcome: report.changed ? 'collapsed' : 'already-collapsed'};
  } catch {
    return {json: dust, outcome: 'as-is'};
  }
}

/** A dust snapshot's cursor in the form preseed.ts compares markers against. */
function dustCursor(json: string): string | null {
  try {
    const offset = (JSON.parse(json) as {offset?: string | number}).offset;
    return offset === undefined ? null : String(BigInt(offset));
  } catch {
    return null;
  }
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
 * The dust state leaves collapsed, even when the store still holds a reference
 * written before references were collapsed, so a bundle never carries megabytes
 * that every wallet seeded from it would deserialize on each launch.
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
    const state = part === 'dust' ? collapsedIfPossible(value).json : value;
    const raw = encoder.encode(state);
    const gz = await gzip(raw);
    files.set(`${part}.dat.gz`, gz);
    parts[part] = { bytes: raw.byteLength, gzipBytes: gz.byteLength };
  }

  // Carry the cursor witnesses. Without them an imported reference is
  // unverifiable on the importing machine, and `referenceCursorsStillValid`
  // treats a missing witness as "allow, with a warning" — deliberately, so an
  // upgrading wallet is not punished. That leniency is right for a local
  // reference and wrong for one that crossed machines, so the bundle brings the
  // evidence with it rather than relying on that path.
  const witnesses: string[] = [];
  for (const part of WITNESSED_PARTS) {
    const witness = await store.get(cursorWitnessKey(networkId, EMPTY_REF_WALLET, part));
    if (!witness) continue;
    files.set(witnessFileName(part), encoder.encode(witness));
    witnesses.push(part);
  }

  return {
    manifest: {network: networkId, height, parts, ...(witnesses.length > 0 ? {witnesses} : {})},
    files,
  };
}

export class ReferenceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceImportError';
  }
}

/** Validate either witness transport and produce canonical stored evidence. */
function inlineWitness(part: 'shielded' | 'dust', value: unknown): string {
  const stream = WITNESS_STREAM[part];
  if (!isCursorWitness(value, stream)) {
    throw new ReferenceImportError(
      `The ${part} witness is malformed — expected {"stream": "${stream}", "id": <positive integer>, ` +
        '"digest": <16 hex characters>}. A witness that cannot be read cannot vouch for the cursor, so the bundle is refused.',
    );
  }
  return JSON.stringify({stream, id: value.id, digest: value.digest} satisfies CursorWitness);
}

/**
 * The witness each witnessed part carries, in the form the store keeps.
 *
 * Validates before anything is written, alongside the parts, so a bundle with
 * broken evidence changes nothing on this machine.
 */
function carriedWitnesses(bundle: PortableReference): Map<'shielded' | 'dust', string> {
  const declared = bundle.manifest.witnesses;
  const listed: readonly string[] = Array.isArray(declared) ? declared : [];
  const inline = declared !== undefined && !Array.isArray(declared)
    ? (declared as Readonly<Record<string, unknown>>)
    : undefined;

  const carried = new Map<'shielded' | 'dust', string>();
  const decoder = new TextDecoder();
  for (const part of WITNESSED_PARTS) {
    const file = bundle.files.get(witnessFileName(part));
    if (file) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(file));
      } catch {
        throw new ReferenceImportError(`${witnessFileName(part)} is malformed JSON.`);
      }
      const checked = inlineWitness(part, parsed);
      if (inline?.[part] !== undefined && inlineWitness(part, inline[part]) !== checked) {
        throw new ReferenceImportError(`The ${part} witness file conflicts with the manifest's witness.`);
      }
      carried.set(part, checked);
      continue;
    }
    // Named in the manifest but not delivered is a bundle that lost its evidence
    // in transit — exactly what a reader that only loads the `.dat.gz` parts
    // produces. Importing it would store a reference that cannot be verified
    // while its own manifest says it can be.
    if (listed.includes(part)) {
      throw new ReferenceImportError(
        `The manifest lists a ${part} witness, but ${witnessFileName(part)} is not in the bundle. ` +
          'Refusing to import a reference whose cursor evidence went missing on the way here.',
      );
    }
    if (inline && inline[part] !== undefined) carried.set(part, inlineWitness(part, inline[part]));
  }
  return carried;
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
 * - a bundle whose witnesses are named but missing, or malformed, would store a
 *   reference that looks verifiable and is not
 *
 * `force` overrides the downgrade check, because re-importing a known-good older
 * bundle to replace a corrupt newer one is a real thing to want.
 *
 * The dust state is stored with its trees collapsed where that can be done and
 * verified, so a bundle cut before references were collapsed still seeds wallets
 * that restore in milliseconds; `dust` in the result says which happened.
 */
export async function importReference(
  store: SyncStateStore,
  networkId: string,
  bundle: PortableReference,
  opts: { force?: boolean } = {},
): Promise<{ height: number; replacedHeight: number | null; dust: DustImportOutcome }> {
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
  const witnesses = carriedWitnesses(bundle);

  // Collapsed before anything is written, with the rest of the preparation.
  const dustEntry = decoded.find(([part]) => part === 'dust') as [WalletPart, string];
  const dust = collapsedIfPossible(dustEntry[1]);
  dustEntry[1] = dust.json;

  // Parts first, height last. The height key is what `preseedReferenceStatus`
  // and the seeding guard read to decide a reference is usable, so writing it
  // before the state it describes would advertise a reference that is still
  // being unpacked — and a process killed midway would leave exactly that.
  for (const [part, json] of decoded) {
    await store.put(emptyRefStateKey(networkId, part), json);
  }

  // Witnesses belong to the state they were taken against, so they are replaced
  // with the parts and NEVER left behind. A machine that had its own witnessed
  // reference would otherwise keep those witnesses next to the imported state:
  // the verification would then check the OLD reference's cursor, pass, and
  // declare the newly imported one valid — a stale witness vouching for state it
  // was never taken from. Absent witnesses leave the reference unverifiable,
  // which the pre-seed guard reports and allows; a wrong one it silently trusts.
  for (const part of WITNESSED_PARTS) {
    const key = cursorWitnessKey(networkId, EMPTY_REF_WALLET, part);
    const carried = witnesses.get(part);
    if (carried) await store.put(key, carried);
    else await store.delete(key);
  }

  // The collapse marker belongs to the state too: recorded when this state was
  // verified collapsed, so the first wallet seeded from it does not check again,
  // and cleared otherwise, so a marker left by the previous reference cannot vouch
  // for this one.
  const cursor = dust.outcome === 'as-is' ? null : dustCursor(dust.json);
  if (cursor !== null) await store.put(emptyRefCollapsedKey(networkId), cursor);
  else await store.delete(emptyRefCollapsedKey(networkId));

  await store.put(emptyRefHeightKey(networkId), String(bundle.manifest.height));

  return { height: bundle.manifest.height, replacedHeight, dust: dust.outcome };
}
