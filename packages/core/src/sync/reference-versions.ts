import {isCursorWitness, verifyCursorWitness, type CursorWitness} from './cursor-witness.js';
import {cursorWitnessKey, emptyRefHeightKey, emptyRefStateKey, EMPTY_REF_WALLET, type SyncStateStore} from './sync-store.js';
import type {EmptyRefStates} from './preseed.js';
import type {NetworkConfig} from '../types/network.js';

export interface ReferenceSnapshot extends EmptyRefStates {
  network: string;
  witnesses: Partial<Record<'shielded' | 'dust', CursorWitness>>;
}
export interface ReferenceVersion extends ReferenceSnapshot { id: string }
export interface ReferenceWallet { name: string; birthday?: number }
interface Assignment { id: string; birthday: number }
interface NetworkReferences {
  epoch: string;
  versions: Record<string, ReferenceVersion>;
  wallets: Record<string, Assignment>;
  /** Newly generated wallets still eligible to contribute their first completed sync. */
  contributors: Record<string, string>;
}
interface Catalog { schema: 1; networks: Record<string, NetworkReferences> }

// One atomic value contains both immutable snapshots and their assignments. A
// killed write cannot publish half a reference or leave orphan snapshot files.
export const REFERENCE_CATALOG_KEY = 'preseed/versions-v1.json';
const locks = new WeakMap<SyncStateStore, Promise<unknown>>();
async function transact<T>(store: SyncStateStore, run: (catalog: Catalog) => Promise<T> | T): Promise<T> {
  const previous = locks.get(store) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const raw = await store.get(REFERENCE_CATALOG_KEY);
    const catalog: Catalog = raw ? JSON.parse(raw) : {schema: 1, networks: {}};
    if (catalog.schema !== 1 || !catalog.networks) throw new Error('Unsupported reference catalog');
    const result = await run(catalog);
    const updated = JSON.stringify(catalog);
    if (updated !== raw) await store.put(REFERENCE_CATALOG_KEY, updated);
    return result;
  });
  locks.set(store, next);
  try { return await next; } finally { if (locks.get(store) === next) locks.delete(store); }
}
function setEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {value, enumerable: true, configurable: true, writable: true});
}
function network(catalog: Catalog, id: string): NetworkReferences {
  if (!Object.hasOwn(catalog.networks, id)) {
    setEntry(catalog.networks, id, {epoch: crypto.randomUUID(), versions: {}, wallets: {}, contributors: {}});
  }
  return catalog.networks[id];
}
function candidates(refs: NetworkReferences, birthday = Number.MAX_SAFE_INTEGER): ReferenceVersion[] {
  return Object.values(refs.versions).filter(r => r.height <= birthday)
    .sort((a, b) => b.height - a.height || a.id.localeCompare(b.id));
}
function assign(refs: NetworkReferences, wallet: ReferenceWallet): void {
  if (!Number.isSafeInteger(wallet.birthday) || wallet.birthday! <= 0) return;
  if (Object.hasOwn(refs.wallets, wallet.name)) return;
  const ref = candidates(refs, wallet.birthday)[0];
  if (ref) setEntry(refs.wallets, wallet.name, {id: ref.id, birthday: wallet.birthday!});
}
function collect(refs: NetworkReferences): void {
  const retained = new Set(Object.values(refs.wallets).map(w => w.id));
  const newest = candidates(refs)[0];
  if (newest) retained.add(newest.id);
  for (const id of Object.keys(refs.versions)) if (!retained.has(id)) delete refs.versions[id];
}
export function validateReferenceSnapshot(snapshot: ReferenceSnapshot, requireWitnesses = true): void {
  if (!snapshot.network || !Number.isSafeInteger(snapshot.height) || snapshot.height <= 0) {
    throw new Error('Reference has no usable network or height');
  }
  for (const part of ['shielded', 'unshielded', 'dust'] as const) {
    const value = JSON.parse(snapshot[part]);
    if (!value || typeof value !== 'object') throw new Error(`Invalid ${part} snapshot`);
    if (part === 'unshielded') continue;
    if (!/^\d+$/.test(String(value.offset)) || BigInt(value.offset) <= 0n) throw new Error(`Invalid ${part} cursor`);
    const witness = snapshot.witnesses[part];
    if (witness === undefined && !requireWitnesses) continue;
    if (!isCursorWitness(witness, part === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents')) {
      throw new Error(`Invalid ${part} witness`);
    }
  }
}
export async function referenceId(snapshot: ReferenceSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    snapshot.network, snapshot.height, snapshot.shielded, snapshot.unshielded, snapshot.dust,
    ...(['shielded', 'dust'] as const).map(part => {
      const w = snapshot.witnesses[part];
      return w ? [w.stream, w.id, w.digest] : null;
    }),
  ]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readLegacyReference(store: SyncStateStore, networkId: string): Promise<ReferenceSnapshot | null> {
  const height = Number(await store.get(emptyRefHeightKey(networkId)));
  if (!Number.isSafeInteger(height) || height <= 0) return null;
  const parts = await Promise.all((['shielded', 'unshielded', 'dust'] as const).map(p => store.get(emptyRefStateKey(networkId, p))));
  if (parts.some(p => !p)) return null;
  const witnesses: ReferenceSnapshot['witnesses'] = {};
  try {
    for (const part of ['shielded', 'dust'] as const) {
      const raw = await store.get(cursorWitnessKey(networkId, EMPTY_REF_WALLET, part));
      if (raw) witnesses[part] = JSON.parse(raw);
    }
    const snapshot = {network: networkId, height, shielded: parts[0]!, unshielded: parts[1]!, dust: parts[2]!, witnesses};
    validateReferenceSnapshot(snapshot, false);
    return snapshot;
  } catch { return null; }
}

/** Must run before adding a newer bundle: first retain the reference existing wallets can use. */
export async function migrateReferenceVersions(store: SyncStateStore, networkId: string, wallets: ReferenceWallet[]): Promise<void> {
  await transact(store, async catalog => {
    const refs = network(catalog, networkId);
    if (Object.keys(refs.versions).length === 0) {
      const legacy = await readLegacyReference(store, networkId);
      if (legacy) {
        const id = await referenceId(legacy);
        refs.versions[id] = {...legacy, id};
      }
    }
    for (const wallet of wallets) assign(refs, wallet);
  });
}

export async function referenceEpoch(store: SyncStateStore, networkId: string): Promise<string> {
  return transact(store, catalog => network(catalog, networkId).epoch);
}
export async function saveReferenceVersion(
  store: SyncStateStore, snapshot: ReferenceSnapshot,
  options: {epoch?: string; contributor?: {name: string; token: string}} = {},
): Promise<ReferenceVersion | null> {
  validateReferenceSnapshot(snapshot);
  const id = await referenceId(snapshot);
  return transact(store, catalog => {
    const refs = network(catalog, snapshot.network);
    // A reset or wallet removal wins over any work started before it.
    if (options.epoch !== undefined && options.epoch !== refs.epoch) return null;
    if (options.contributor !== undefined && refs.contributors[options.contributor.name] !== options.contributor.token) return null;
    const version = {...snapshot, id};
    refs.versions[id] = version;
    if (options.contributor !== undefined) delete refs.contributors[options.contributor.name];
    collect(refs);
    return version;
  });
}

export async function registerReferenceWallet(store: SyncStateStore, networkId: string, wallet: ReferenceWallet, contribute = false): Promise<void> {
  await transact(store, catalog => {
    const refs = network(catalog, networkId);
    assign(refs, wallet);
    if (contribute && Number.isSafeInteger(wallet.birthday) && wallet.birthday! > 0) setEntry(refs.contributors, wallet.name, crypto.randomUUID());
  });
}
export async function referenceContributionToken(store: SyncStateStore, networkId: string, name: string): Promise<string | null> {
  return transact(store, catalog => {
    const refs = network(catalog, networkId);
    return Object.hasOwn(refs.contributors, name) ? refs.contributors[name] : null;
  });
}
export async function finishReferenceContribution(store: SyncStateStore, networkId: string, name: string, epoch: string, token: string): Promise<void> {
  await transact(store, catalog => {
    const refs = network(catalog, networkId);
    if (refs.epoch === epoch && refs.contributors[name] === token) delete refs.contributors[name];
  });
}

export type CheckReference = (reference: ReferenceVersion) => Promise<boolean>;
export async function referenceStillValid(reference: ReferenceVersion, indexerUrl: string): Promise<boolean> {
  for (const part of ['shielded', 'dust'] as const) {
    const witness = reference.witnesses[part];
    // Legacy unwitnessed snapshots retain the pre-existing compatibility policy.
    if (!witness) continue;
    if (!isCursorWitness(witness, part === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents')) return false;
    if ((await verifyCursorWitness(indexerUrl, witness)).kind !== 'valid') return false;
  }
  return true;
}

/** A pinned reference is preferred; a bad witness never becomes a permission to skip history. */
export async function selectReferenceVersion(
  store: SyncStateStore, config: Pick<NetworkConfig, 'id' | 'indexerUrl'>,
  wallet?: ReferenceWallet,
  check: CheckReference = ref => referenceStillValid(ref, config.indexerUrl),
): Promise<ReferenceVersion | null> {
  if (wallet && (!Number.isSafeInteger(wallet.birthday) || wallet.birthday! <= 0)) return null;
  const {epoch, choices} = await transact(store, catalog => {
    const refs = network(catalog, config.id);
    const choices = candidates(refs, wallet?.birthday);
    const pinned = wallet && Object.hasOwn(refs.wallets, wallet.name) && refs.wallets[wallet.name].id;
    if (pinned) choices.sort((a, b) => Number(b.id === pinned) - Number(a.id === pinned));
    return {epoch: refs.epoch, choices};
  });
  for (const ref of choices) {
    if (!(await check(ref))) continue;
    return transact(store, catalog => {
      const refs = network(catalog, config.id);
      if (refs.epoch !== epoch || !refs.versions[ref.id]) return null;
      if (wallet) setEntry(refs.wallets, wallet.name, {id: ref.id, birthday: wallet.birthday!});
      collect(refs);
      return ref;
    });
  }
  return null;
}

/**
 * A candidate for core's DUST-history probe, not permission to seed a wallet.
 * No birthday or wallet assignment is changed. Unlike legacy birthday-based
 * recovery, this fallback requires complete witnesses before consulting history.
 */
export async function selectDustReferenceCandidate(
  store: SyncStateStore, config: Pick<NetworkConfig, 'id' | 'indexerUrl'>,
  check: CheckReference = ref => referenceStillValid(ref, config.indexerUrl),
): Promise<ReferenceVersion | null> {
  return selectReferenceVersion(store, config, undefined, async ref => {
    try { validateReferenceSnapshot(ref); } catch { return false; }
    return check(ref);
  });
}

export async function referenceVersionsStatus(store: SyncStateStore, networkId: string): Promise<{ready: boolean; height: number | null}> {
  return transact(store, catalog => {
    const newest = candidates(network(catalog, networkId))[0];
    return {ready: !!newest, height: newest?.height ?? null};
  });
}
export async function forgetReferenceWallet(store: SyncStateStore, name: string): Promise<void> {
  await transact(store, catalog => {
    for (const refs of Object.values(catalog.networks)) {
      delete refs.wallets[name];
      delete refs.contributors[name];
      collect(refs);
    }
  });
}
export async function resetReferenceVersions(store: SyncStateStore, networkId: string): Promise<void> {
  await transact(store, catalog => {
    delete catalog.networks[networkId];
    network(catalog, networkId); // Persist a new epoch to invalidate unfinished workers.
  });
}
