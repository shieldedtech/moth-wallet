// Load a pre-seed reference shipped inside the extension package into IndexedDB.
//
// Why bundle one at all: without a reference a fresh install walks the whole
// chain, which dust makes a 78.6-minute job on preprod. Building one on the
// device costs the same walk, so it cannot go on the startup path (see
// preseed.ts). Shipping one already built removes the walk entirely — measured
// on preprod against a reference 59,236 blocks stale: 103.1s to fully synced.
//
// Staleness costs catch-up time, not correctness. The wallet syncs forward from
// the reference height, and the `reference.height <= birthday` guard still
// decides whether any given account may use it — an account created before the
// shipped reference was cut is refused, exactly as it would be for a locally
// built one.
//
// No new trust surface: the reference travels inside the signed extension
// package, so it is exactly as trustworthy as the code that reads it. That is
// the main argument for bundling rather than fetching it at runtime, where the
// wallet would gain both a network dependency and a party to trust — and would
// leak "this IP created a wallet on network X at time T" at the moment least
// worth leaking.

import { archiveReference, cursorWitnessKey, emptyRefStateKey, emptyRefHeightKey, readArchiveIndex, EMPTY_REF_WALLET, type SyncStateStore, type WalletPart } from '@shieldedtech/moth-wallet/sync/sync-store';

const PARTS: WalletPart[] = ['shielded', 'unshielded', 'dust'];

interface Manifest {
  network: string;
  height: number;
  parts: Record<string, { bytes: number; gzipBytes: number }>;
  /**
   * Hash of the event each cursor points at, recorded at export time.
   *
   * Required. A bundle's cursors are indexer-assigned event numbers, so without
   * these there is no way to tell whether the numbering they were written under
   * still holds — which is how a stale preprod reference shipped and kept being
   * installed (#40). Checksums prove the bytes arrived, not that the cursors
   * still mean what they meant.
   */
  witnesses?: Record<string, { stream: string; id: number; digest: string }>;
}

/** Package-relative, so this works in the worker without extension APIs — the
 *  worker's origin is already the extension's. */
function assetUrl(networkId: string, file: string): string {
  return new URL(`/preseed/${networkId}/${file}`, self.location.href).toString();
}

async function fetchText(url: string, gzipped: boolean): Promise<string | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  if (!gzipped) return response.text();
  // DecompressionStream keeps the 9.8 MB dust state out of memory in one piece
  // and is available in workers; the alternative is shipping it uncompressed and
  // doubling what the package carries.
  const stream = response.body?.pipeThrough(new DecompressionStream('gzip'));
  if (!stream) return null;
  return new Response(stream).text();
}

/** Parse a fetched manifest, or null if it is not one.
 *
 * The validation is not paranoia about our own build output. In `wxt dev` the
 * assets are served by a dev server that answers unknown paths with the app's
 * HTML rather than a 404, so "the fetch succeeded" does not mean "this network
 * ships a reference". Requiring a positive height is what makes the answer the
 * same in dev as in a packaged build.
 */
function parseManifest(text: string | null): Manifest | null {
  if (!text) return null;
  try {
    const manifest = JSON.parse(text) as Manifest;
    if (!Number.isFinite(manifest.height) || manifest.height <= 0) return null;
    // A bundle we cannot verify is refused rather than trusted. Unlike a local
    // reference — where the same strictness would force every existing user into
    // a chain walk on upgrade — this is an artefact we control and can re-cut, so
    // the cost of refusing is one slower first sync, and the cost of trusting is
    // a wallet silently resuming at the wrong event.
    for (const part of ['shielded', 'dust'] as const) {
      const witness = manifest.witnesses?.[part];
      if (!witness || typeof witness.digest !== 'string' || !Number.isFinite(witness.id)) return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

/** Probed at most once per network per worker: the answer cannot change without
 *  reloading the extension, and the UI asks on every Settings poll. */
const bundledProbe = new Map<string, Promise<boolean>>();

/**
 * Whether this release ships a reference for `networkId`.
 *
 * Only the manifest is fetched, so this stays cheap enough to poll. It exists so
 * the UI can tell the two "not ready yet" cases apart: a network we ship a
 * reference for is about to have one installed, and offering to build it on the
 * device would be offering an hour of work to arrive at what is already in the
 * package. A network we ship nothing for has the build as its only option.
 */
export function hasBundledReference(networkId: string): Promise<boolean> {
  const probed = bundledProbe.get(networkId);
  if (probed) return probed;
  const probe = fetchText(assetUrl(networkId, 'manifest.json'), false)
    .then((text) => parseManifest(text) !== null)
    .catch(() => false);
  bundledProbe.set(networkId, probe);
  return probe;
}

/**
 * Install the bundled reference for `networkId` if the store has none.
 *
 * Best-effort and idempotent. A missing or unreadable asset is not an error —
 * not every network ships one, and a wallet without a reference syncs the slow
 * way rather than failing. Returns whether anything was written.
 *
 * Writes the height LAST, deliberately. `loadUsableRefStates` treats a reference
 * with no recorded height as unusable, so an interrupted install leaves state
 * that is ignored rather than trusted — the failure mode is a slow sync, never a
 * wallet seeded from half a reference.
 */
/**
 * Fetch all three parts, or nothing.
 *
 * All three or none: a partial reference is refused by the reader anyway, and
 * writing it wastes IndexedDB quota.
 */
async function fetchStates(
  networkId: string,
): Promise<{shielded: string; unshielded: string; dust: string} | null> {
  const states: Partial<Record<WalletPart, string>> = {};
  for (const part of PARTS) {
    const value = await fetchText(assetUrl(networkId, `${part}.dat.gz`), true);
    if (!value) return null;
    states[part] = value;
  }
  return states as {shielded: string; unshielded: string; dust: string};
}

export async function installBundledReference(networkId: string, store: SyncStateStore): Promise<boolean> {
  try {
    // A locally built or previously installed reference wins the LIVE slot,
    // since it is at least as fresh as anything we ship.
    const live = await store.get(emptyRefHeightKey(networkId));

    const manifest = parseManifest(await fetchText(assetUrl(networkId, 'manifest.json'), false));
    if (!manifest) return false;

    // …but it does not make the bundle worthless. The bundle sits at a fixed,
    // usually older height, and an older reference is exactly what a wallet
    // imported with an earlier birthday needs — the live one is above it and so
    // holds none of that wallet's history. Archive the bundle in that case
    // instead of discarding it. Skipped once archived, so this costs one install.
    if (live) {
      if ((await readArchiveIndex(store, networkId)).includes(manifest.height)) return false;
      const archived = await fetchStates(networkId);
      if (!archived) return false;
      // No witnesses are written here: they are keyed to the live slot, and the
      // verifier only reads that slot. An archived reference is therefore handed
      // out unverified — the one place #50's renumbering check does not reach.
      await archiveReference(store, networkId, manifest.height, archived);
      return true;
    }

    const states = await fetchStates(networkId);
    if (!states) return false;

    for (const part of PARTS) await store.put(emptyRefStateKey(networkId, part), states[part]);
    // Witnesses before the height, for the same reason the height goes last: the
    // height is what marks the reference usable, and a reference that reads as
    // usable without its witnesses is one that skips verification.
    //
    // Live slot only — witnesses are keyed to EMPTY_REF_WALLET, so the archived
    // copy written below carries none. See the note on the archive-only path.
    for (const [part, witness] of Object.entries(manifest.witnesses ?? {})) {
      await store.put(cursorWitnessKey(networkId, EMPTY_REF_WALLET, part as WalletPart), JSON.stringify(witness));
    }
    await store.put(emptyRefHeightKey(networkId), String(manifest.height));
    // Also keep it at its own height, so a later local build overwriting the
    // live slot does not take the bundle's coverage with it.
    await archiveReference(store, networkId, manifest.height, states);
    return true;
  } catch {
    // Never let a packaging problem stop a wallet from starting.
    return false;
  }
}
