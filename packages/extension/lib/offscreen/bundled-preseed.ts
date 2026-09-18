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

import {type SyncStateStore, type WalletPart} from '@shieldedtech/moth-wallet/sync/sync-store';
import {isCursorWitness} from '@shieldedtech/moth-wallet/sync/cursor-witness';
import {migrateReferenceVersions, referenceEpoch, referenceVersionsStatus, saveReferenceVersion, type ReferenceSnapshot, type ReferenceWallet} from '@shieldedtech/moth-wallet/sync/reference-versions';

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
  // DecompressionStream is available in workers and keeps the parts compressed in
  // the package. The dust state was the reason this mattered (megabytes before
  // its trees were collapsed at export); it is kilobytes now, but a reference cut
  // without collapsing still loads.
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
      if (!isCursorWitness(witness, part === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents')) return null;
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
 * Add a newer bundled version after assigning the old reference to existing
 * eligible wallets. Old assigned versions survive upgrades and DUST rebuilds.
 *
 * Best-effort and idempotent. A missing or unreadable asset is not an error —
 * not every network ships one, and a wallet without a reference syncs the slow
 * way rather than failing. Returns whether anything was written.
 *
 * Publication is one catalog write containing all parts, witnesses and wallet
 * assignments. Failed or interrupted installation leaves the old catalog usable.
 */
export async function installBundledReference(networkId: string, store: SyncStateStore, wallets: ReferenceWallet[] = []): Promise<boolean> {
  try {
    // Capture the reset generation before asset fetches can yield. A reset must
    // not be undone by an installation already in flight.
    await migrateReferenceVersions(store, networkId, wallets);
    const epoch = await referenceEpoch(store, networkId);
    const manifest = parseManifest(await fetchText(assetUrl(networkId, 'manifest.json'), false));
    if (!manifest || manifest.network !== networkId) return false;

    // A local refresh may be newer than the bundle. The catalog already holds
    // it; do not add redundant older versions without wallet assignments.
    const status = await referenceVersionsStatus(store, networkId);
    if (status.height !== null && status.height >= manifest.height) return false;

    const states: Partial<Record<WalletPart, string>> = {};
    for (const part of PARTS) {
      const value = await fetchText(assetUrl(networkId, `${part}.dat.gz`), true);
      // All three or none: a partial reference would be refused by
      // loadUsableRefStates anyway, and writing it wastes IndexedDB quota.
      if (!value) return false;
      states[part] = value;
    }

    return (await saveReferenceVersion(store, {
      network: networkId, height: manifest.height,
      shielded: states.shielded!, unshielded: states.unshielded!, dust: states.dust!,
      witnesses: manifest.witnesses as ReferenceSnapshot['witnesses'],
    }, {epoch})) !== null;
  } catch {
    // Never let a packaging problem stop a wallet from starting.
    return false;
  }
}
