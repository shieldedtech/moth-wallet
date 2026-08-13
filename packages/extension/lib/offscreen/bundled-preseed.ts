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

import { emptyRefStateKey, emptyRefHeightKey, type SyncStateStore, type WalletPart } from '@shieldedtech/moth-wallet/sync/sync-store';

const PARTS: WalletPart[] = ['shielded', 'unshielded', 'dust'];

interface Manifest {
  network: string;
  height: number;
  parts: Record<string, { bytes: number; gzipBytes: number }>;
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
export async function installBundledReference(networkId: string, store: SyncStateStore): Promise<boolean> {
  try {
    // Already present — a locally built or previously installed reference wins,
    // since it is at least as fresh as anything we ship.
    if (await store.get(emptyRefHeightKey(networkId))) return false;

    const manifest = parseManifest(await fetchText(assetUrl(networkId, 'manifest.json'), false));
    if (!manifest) return false;

    const states: Partial<Record<WalletPart, string>> = {};
    for (const part of PARTS) {
      const value = await fetchText(assetUrl(networkId, `${part}.dat.gz`), true);
      // All three or none: a partial reference would be refused by
      // loadUsableRefStates anyway, and writing it wastes IndexedDB quota.
      if (!value) return false;
      states[part] = value;
    }

    for (const part of PARTS) await store.put(emptyRefStateKey(networkId, part), states[part]!);
    await store.put(emptyRefHeightKey(networkId), String(manifest.height));
    return true;
  } catch {
    // Never let a packaging problem stop a wallet from starting.
    return false;
  }
}
