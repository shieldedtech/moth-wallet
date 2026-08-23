// Pre-seed optimization for newly generated wallets.
// Syncs an empty reference wallet to chain tip once per network, then
// copies its state snapshot to new wallets with swapped keys.
// This avoids the full genesis scan for all three sub-wallets, DUST included:
// the reference's dust state and offset are reused with the new wallet's public
// key swapped in. DUST is the one that matters — its blob is 4.9 MB against
// shielded's 3.9 KB, and it is the sub-wallet that otherwise replays ~1.4M
// events. A DUST pre-seed failure is non-fatal and falls back to a genesis scan
// for that part alone, which presents as "sync is oddly slow" rather than an
// error.
// Architecture follows mn-tui. See NOTICE for attribution.

// Key derivation now flows through deriveWalletKeys (Option A); the reference
// state persists through the async SyncStateStore (browser-safe), so v8's
// node:fs pre-seed bridge is not used here.
import {generateMnemonic24, mnemonicToSeed} from '../wallet/mnemonic.js';
import {createKeystore, PublicKey} from '@midnightntwrk/wallet-sdk/unshielded';
import {setNetworkId} from '@midnight-ntwrk/midnight-js/network-id';
import type {NetworkConfig} from '../types/network.js';
import {startWalletSync, resolveSyncStore} from './wallet-sync.js';
import {archiveReference, archivedRefSlot, archivedRefStateKey, cursorWitnessKey, emptyRefHeightKey, emptyRefMnemonicKey, emptyRefStateKey, readArchiveIndex, EMPTY_REF_WALLET, type SyncStateStore, type WalletPart} from './sync-store.js';
import {
  compareWitness,
  readEventWitness,
  type CursorWitness,
  type WitnessStream,
} from './cursor-witness.js';
import {IndexerClient} from '../network/indexer-client.js';
import {deriveWalletKeys, type WalletKeys} from './operations.js';

export interface EmptyRefStates {
  shielded: string;
  unshielded: string;
  dust: string;
  /**
   * Chain height this reference was synced to. Callers MUST refuse to pre-seed a
   * wallet whose birthday precedes it: the reference carries the chain's state at
   * this height, so seeding a wallet that was already active earlier would skip
   * that wallet's own history. Compared against `birthday` (also a height) —
   * never against a snapshot `offset`, which is an event index.
   */
  height: number;
}

/** Reference-build progress, for surfacing an hour-long job in the UI. */
export interface WarmProgress {
  /** Dust events applied so far — the sub-wallet that dominates the build. */
  applied: number;
  /** Dust events the chain currently has. Grows slowly as the chain advances. */
  total: number;
  synced: boolean;
}

// In-memory cache: network → synced reference states
const refCache = new Map<string, EmptyRefStates>();
const refInFlight = new Map<string, Promise<EmptyRefStates | null>>();

/**
 * How long a deliberate reference build may take before giving up. Dust
 * dominates: it streams the whole chain (~1.4M events on preprod at a few
 * hundred per second), so this has to be generous. A build that times out
 * leaves its partial state in the store, and the next attempt resumes from it.
 */
const REF_BUILD_TIMEOUT_MS = 2 * 60 * 60_000;

function loadRefState(store: SyncStateStore, networkId: string, part: WalletPart): Promise<string | null> {
  return store.get(emptyRefStateKey(networkId, part));
}

/**
 * The applied index a serialized sub-wallet snapshot resumes from.
 *
 * `offset` is what the SDK writes from `progress.appliedIndex` and reads back as
 * `appliedIndex` on restore (see makeDefaultV1SerializationCapability in the
 * dust wallet's Serialization.ts). An offset of 0 is the "nothing applied yet"
 * sentinel: the sync then opens its subscription with no cursor and streams from
 * genesis. So a reference whose offset is 0 seeds nothing, however complete the
 * rest of the snapshot looks.
 */
/**
 * Which event stream a part's cursor indexes into.
 *
 * Only shielded and dust ride the indexer's global ledger-event numbering, and
 * they are the two the preprod renumbering moved. Unshielded is keyed by address
 * and its cursor is a transaction id, so it is not witnessed here.
 */
function witnessStreamFor(part: WalletPart): WitnessStream | null {
  if (part === 'dust') return 'dustLedgerEvents';
  if (part === 'shielded') return 'zswapLedgerEvents';
  return null;
}

/**
 * Record what the reference's cursors pointed at, so a later renumbering is
 * detectable.
 *
 * Best-effort: a reference without witnesses is treated as unverifiable rather
 * than invalid, because refusing every pre-existing reference on upgrade would
 * force a chain walk on everyone at once. New references get witnesses, so the
 * population converges.
 */
async function recordReferenceWitnesses(
  store: SyncStateStore,
  network: NetworkConfig,
  states: {shielded: string; dust: string},
  onProgress?: (msg: string) => void,
): Promise<Partial<Record<WalletPart, string>>> {
  const written: Partial<Record<WalletPart, string>> = {};
  for (const part of ['shielded', 'dust'] as const) {
    const stream = witnessStreamFor(part);
    if (!stream) continue;
    const id = Number(snapshotOffset(states[part]));
    if (!Number.isFinite(id) || id <= 0) continue;
    try {
      const witness = await readEventWitness(network.indexerUrl, stream, id);
      if (!witness) continue;
      const serialized = JSON.stringify(witness);
      await store.put(cursorWitnessKey(network.id, EMPTY_REF_WALLET, part), serialized);
      // Returned so the archived copy gets the same witnesses under its own
      // slot. Re-reading them from the indexer per archive would be a second
      // round trip for an answer already in hand.
      written[part] = serialized;
    } catch (err) {
      onProgress?.(`Pre-seed: could not witness the ${part} cursor (${err}) — this reference will be unverifiable`);
    }
  }
  return written;
}

/**
 * Refuse a reference whose cursors no longer mean what they did.
 *
 * The failure this prevents is silent: cursors are indexer-assigned event
 * numbers, so when the same URL serves a differently-numbered stream a stored
 * cursor names a different event and the sync resumes at the wrong place without
 * erroring. Preprod did exactly that — the shipped reference's dust cursor
 * (1431375) sits 22 events beyond the state it describes under the current
 * numbering.
 *
 * Returns true when the reference is safe to use. A missing witness returns true
 * with a warning: see recordReferenceWitnesses on why upgrades are not punished.
 */
async function referenceCursorsStillValid(
  store: SyncStateStore,
  network: NetworkConfig,
  /**
   * Which reference to check: the live slot, or an archived one's
   * `archivedRefSlot(height)`. Archived references carry indexer-assigned
   * cursors exactly as the live one does, so they need the same check — and
   * before this took a slot they silently got none.
   */
  slot: string,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  const label = slot === EMPTY_REF_WALLET ? 'reference' : `archived reference ${slot.split('@')[1]}`;
  for (const part of ['shielded', 'dust'] as const) {
    const raw = await store.get(cursorWitnessKey(network.id, slot, part));
    if (!raw) {
      onProgress?.(`Pre-seed: ${label} has no ${part} witness — cannot prove its cursor is still valid`);
      continue;
    }
    let stored: CursorWitness;
    try {
      stored = JSON.parse(raw) as CursorWitness;
    } catch {
      continue;
    }
    let observed: CursorWitness | null = null;
    try {
      observed = await readEventWitness(network.indexerUrl, stored.stream, stored.id);
    } catch (err) {
      onProgress?.(`Pre-seed: could not re-check the ${label}'s ${part} cursor (${err}) — refusing it`);
      return false;
    }
    const verdict = compareWitness(stored, observed);
    if (verdict.kind === 'valid') continue;
    onProgress?.(
      verdict.kind === 'renumbered'
        ? `Pre-seed: the indexer has renumbered its ${part} events — the ${label}'s cursor now names a ` +
          `different event (expected ${verdict.expected}, found ${verdict.actual}). Refusing it and syncing ` +
          'from genesis, which is always correct.'
        : `Pre-seed: cannot verify the ${label}'s ${part} cursor (${verdict.reason}) — refusing it.`,
    );
    return false;
  }
  return true;
}

function snapshotOffset(raw: string): bigint {
  try {
    const parsed = JSON.parse(raw) as { offset?: string | number };
    return parsed.offset === undefined ? 0n : BigInt(parsed.offset);
  } catch {
    return 0n;
  }
}

/** The newest archived reference usable for `birthday`, or null. */
async function loadArchivedRefStates(
  store: SyncStateStore,
  networkId: string,
  birthday: number,
): Promise<EmptyRefStates | null> {
  for (const height of await readArchiveIndex(store, networkId)) {
    if (height > birthday) continue;
    const [shielded, unshielded, dust] = await Promise.all([
      store.get(archivedRefStateKey(networkId, height, 'shielded')),
      store.get(archivedRefStateKey(networkId, height, 'unshielded')),
      store.get(archivedRefStateKey(networkId, height, 'dust')),
    ]);
    if (shielded && unshielded && dust) return {shielded, unshielded, dust, height};
  }
  return null;
}

/**
 * Read the cached reference states, but only accept them if they actually
 * reached chain tip. Guards against the failure mode this cache had for months:
 * the reference was serialized moments after starting, so every part sat at
 * offset 0 and new wallets full-scanned anyway while being told they were
 * pre-seeded "at chain tip".
 *
 * This reads the LIVE reference — the most recent build, at whatever height it
 * reached. `loadArchivedRefStates` is the counterpart for older ones.
 */
async function loadUsableRefStates(
  store: SyncStateStore,
  networkId: string,
): Promise<EmptyRefStates | null> {
  const [shielded, unshielded, dust] = await Promise.all([
    loadRefState(store, networkId, 'shielded'),
    loadRefState(store, networkId, 'unshielded'),
    loadRefState(store, networkId, 'dust'),
  ]);
  if (!shielded || !unshielded || !dust) return null;
  // Dust is the expensive one and the one whose cursor we are really after;
  // shielded is checked too so a half-built reference is not treated as warm.
  if (snapshotOffset(dust) <= 0n || snapshotOffset(shielded) <= 0n) return null;

  // No recorded height means no way to prove the reference is not newer than a
  // given wallet's birthday, so it cannot be used safely at all.
  const rawHeight = await store.get(emptyRefHeightKey(networkId));
  const height = rawHeight ? Number(rawHeight) : 0;
  if (!Number.isFinite(height) || height <= 0) return null;

  return { shielded, unshielded, dust, height };
}

/** Wait until the wallet reports fully synced, or give up. */
function waitForTip(
  synced: { balances: { synced: boolean }; subscribe: (cb: (b: { synced: boolean }) => void) => () => void },
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (reached: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(reached);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // subscribe() replays the current balances synchronously, so an
    // already-synced wallet settles here without waiting for a fresh emission.
    const stop = synced.subscribe((b) => {
      if (b.synced) {
        clearTimeout(timer);
        finish(true);
      }
    });
    unsubscribe = stop;
    if (settled) stop();
  });
}

/**
 * Ensure an empty reference wallet is synced to chain tip for this network.
 * The first call per network syncs from genesis (or restores from cache).
 * Subsequent calls return the cached result immediately.
 */
// NOTE: v8 had a loadFreshRefFromDisk() that reused a recently-warmed on-disk
// reference across daemon processes by stat-ing ~/.moth .dat mtimes. Under the
// async SyncStateStore model that cross-process reuse is subsumed by the store
// itself: buildEmptyRefCache reuses the reference mnemonic from the store and
// startWalletSync restores the cached ref state from it, so a second process
// resumes from cache rather than genesis without any node:fs freshness probe.
export async function ensureEmptyRefCache(
  network: NetworkConfig,
  onProgress?: (msg: string) => void,
  store?: SyncStateStore,
  /**
   * Build the reference if none is warm yet. OFF by default, and deliberately
   * so: building means syncing an empty wallet to chain tip, which dust makes a
   * tens-of-minutes job. On the wallet-startup path that would block the user's
   * own wallet from starting, which is far worse than letting it sync from
   * genesis in the background. Callers that mean to pay the cost use
   * warmEmptyRefCache().
   */
  opts?: { build?: boolean; onWarmProgress?: (p: WarmProgress) => void; birthday?: number }
): Promise<EmptyRefStates | null> {
  const birthday = opts?.birthday;
  const cached = refCache.get(network.id);
  if (cached && (birthday === undefined || cached.height <= birthday)) return cached;

  // A reference already synced to tip by an earlier run (or another process)
  // is usable immediately, with no sync of any kind.
  const resolved = await resolveSyncStore(store);
  const warm = await loadUsableRefStates(resolved, network.id);
  if (warm && (birthday === undefined || warm.height <= birthday)) {
    // Verified before it is handed out, not after. This reference is what every
    // new wallet on this machine inherits, so using it across a renumbering
    // spreads the skew instead of containing it.
    if (!(await referenceCursorsStillValid(resolved, network, EMPTY_REF_WALLET, onProgress))) return null;
    // Memoised after verification, so the check costs one subscription per
    // process rather than one per wallet. The trade is that a renumbering that
    // lands mid-process is not re-detected until the next start; the alternative
    // is a network round trip on every pre-seed, which is the path this whole
    // feature exists to keep cheap.
    refCache.set(network.id, warm);
    return warm;
  }

  // The live reference is newer than this wallet, so it holds nothing of the
  // wallet's own history. An archived reference at or below the birthday still
  // does, and seeding from it turns a genesis walk into a birthday-to-tip one.
  // Never memoised: the choice belongs to this birthday, not to the network.
  if (birthday !== undefined) {
    const archived = await loadArchivedRefStates(resolved, network.id, birthday);
    if (archived) {
      // Verified against its OWN slot. Before this, an archived reference was the
      // one path that skipped the renumbering check entirely — which is the path
      // an older wallet takes, so the check was missing exactly where a stale
      // cursor is most likely.
      if (await referenceCursorsStillValid(resolved, network, archivedRefSlot(archived.height), onProgress)) {
        return archived;
      }
      onProgress?.(
        `Pre-seed: refusing the archived reference at ${archived.height} — syncing from genesis, which is always correct.`,
      );
      return null;
    }
  }

  const inFlight = refInFlight.get(network.id);
  if (inFlight) return inFlight;

  if (!opts?.build) {
    onProgress?.(`Pre-seed: no reference at or below birthday ${birthday ?? 'none'} for ${network.id} — syncing from genesis`);
    return null;
  }

  const promise = buildEmptyRefCache(network, onProgress, store, opts?.onWarmProgress);
  refInFlight.set(network.id, promise);
  try {
    const result = await promise;
    if (result) refCache.set(network.id, result);
    return result;
  } finally {
    refInFlight.delete(network.id);
  }
}

/**
 * Build (or resume building) the empty reference wallet for a network, syncing
 * it all the way to chain tip so it can actually pre-seed new wallets.
 *
 * This is the slow one: the first build walks the whole chain, which dust makes
 * a tens-of-minutes job on preprod. It is worth paying once per network per
 * machine, because afterwards every new wallet — and every dust rebuild — starts
 * at tip instead of genesis. Intended for a background task or an explicit
 * command, never the wallet-startup path.
 */
/**
 * Sync an EXISTING reference forward to chain tip, instead of rebuilding it.
 *
 * ensureEmptyRefCache short-circuits on a warm reference, so before this the only
 * way to update one was to delete it and walk the chain again — 53.6 min on
 * preprod. That was never a limitation of the mechanism, only of the entry
 * points: buildEmptyRefCache already resumes from whatever reference state the
 * store holds (it syncs under EMPTY_REF_WALLET, and startWalletSync restores that
 * wallet's cache like any other), so catching up costs the drift and nothing more.
 *
 * A stale reference is safe to use — it only means more catch-up for the wallets
 * it seeds, at roughly half a second per hour of age — so this is an optimisation,
 * not a repair. Run it before cutting a release, or on a schedule.
 */
export async function refreshEmptyRefCache(
  network: NetworkConfig,
  onProgress?: (msg: string) => void,
  store?: SyncStateStore,
  onWarmProgress?: (p: WarmProgress) => void
): Promise<EmptyRefStates | null> {
  // Drop the in-process memo so the refreshed state is what later callers see.
  refCache.delete(network.id);

  // Refuse to resume across a renumbering. A refresh continues from the stored
  // cursor, so doing it after the ids underneath moved would launder the skew
  // into a reference that then looks freshly built — the worst outcome available,
  // because it destroys the evidence. Only a genesis rebuild is correct here, so
  // the caller is told to clear the reference rather than being quietly served a
  // wrong one.
  const resolvedStore = await resolveSyncStore(store);
  const existing = await loadUsableRefStates(resolvedStore, network.id);
  if (existing && !(await referenceCursorsStillValid(resolvedStore, network, EMPTY_REF_WALLET, onProgress))) {
    onProgress?.(
      'Pre-seed: refusing to refresh across an indexer renumbering — resuming would carry the old ' +
        'numbering forward. Delete this network\'s reference and build again from genesis.',
    );
    return null;
  }

  // Share an in-flight build rather than starting a second chain walk beside it.
  const inFlight = refInFlight.get(network.id);
  if (inFlight) return inFlight;

  const promise = buildEmptyRefCache(network, onProgress, store, onWarmProgress);
  refInFlight.set(network.id, promise);
  try {
    const result = await promise;
    if (result) refCache.set(network.id, result);
    return result;
  } finally {
    refInFlight.delete(network.id);
  }
}

export function warmEmptyRefCache(
  network: NetworkConfig,
  onProgress?: (msg: string) => void,
  store?: SyncStateStore,
  onWarmProgress?: (p: WarmProgress) => void
): Promise<EmptyRefStates | null> {
  return ensureEmptyRefCache(network, onProgress, store, { build: true, onWarmProgress });
}

/**
 * Whether this network has a reference at chain tip, without building anything.
 * Lets a UI distinguish "not started" from "in progress" from "done" — a build
 * runs for an hour, so reporting it as perpetually in progress is misleading.
 */
/**
 * Heights of the archived references held for this network, newest first.
 *
 * The archive is what decides which birthdays can seed, so it has to be
 * inspectable: "no reference below your birthday" is otherwise indistinguishable
 * from "pre-seeding is broken" when a sync unexpectedly starts at genesis.
 */
export async function archivedReferenceHeights(
  network: NetworkConfig,
  store?: SyncStateStore,
): Promise<number[]> {
  return readArchiveIndex(await resolveSyncStore(store), network.id);
}

export async function preseedReferenceStatus(
  network: NetworkConfig,
  store?: SyncStateStore
): Promise<{ ready: boolean; height: number | null }> {
  const resolved = await resolveSyncStore(store);
  const states = await loadUsableRefStates(resolved, network.id);
  return { ready: states !== null, height: states?.height ?? null };
}

async function buildEmptyRefCache(
  network: NetworkConfig,
  onProgress?: (msg: string) => void,
  store?: SyncStateStore,
  onWarmProgress?: (p: WarmProgress) => void
): Promise<EmptyRefStates | null> {
  const resolved = await resolveSyncStore(store);

  // Archive whatever the live slot already holds, BEFORE this build advances it.
  // The build resumes the same reference wallet forward, so without this the
  // older, lower height is simply gone — and a lower reference is precisely what
  // a wallet imported with an earlier birthday needs. Idempotent: a height
  // already in the index is not rewritten.
  const existing = await loadUsableRefStates(resolved, network.id);
  if (existing && !(await readArchiveIndex(resolved, network.id)).includes(existing.height)) {
    await archiveReference(resolved, network.id, existing.height, existing);
    onProgress?.(`Pre-seed: archived the existing reference at height ${existing.height}`);
  }

  // Generate or reuse a reference mnemonic
  // Reference wallet mnemonic — this wallet is never funded and exists only
  // as an empty-at-tip cache for pre-seeding new wallets.
  // SECURITY: Stored with owner-only permissions (0600). Do NOT fund this wallet.
  const mnemonicKey = emptyRefMnemonicKey(network.id);
  let mnemonic = (await resolved.get(mnemonicKey))?.trim();
  if (mnemonic) {
    onProgress?.('Pre-seed: reusing reference wallet');
  } else {
    mnemonic = generateMnemonic24();
    await resolved.put(mnemonicKey, mnemonic);
    onProgress?.('Pre-seed: generated new reference wallet (first sync may be slow)');
  }

  // Derive seed + typed key bundle
  const seed = await mnemonicToSeed(mnemonic);
  const seedHex = Array.from(seed).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const referenceKeys = deriveWalletKeys(seedHex);
  // Seed is no longer needed past derivation — zero the local buffer.
  seed.fill(0);

  onProgress?.('Pre-seed: syncing reference wallet to chain tip...');
  try {
    // Sync the reference wallet under EMPTY_REF_WALLET into the shared async
    // store; startWalletSync persists each sub-wallet's state there, so
    // loadRefState reads it straight back — no separate fs promotion needed.
    const synced = await startWalletSync(referenceKeys, network, onProgress, EMPTY_REF_WALLET, undefined, undefined, {
      syncStore: resolved,
    });

    // Wait for the reference to actually reach tip before serializing it.
    // startWalletSync resolves on the first balance emission (or a 5s timeout),
    // so stopping straight away — as this did — serialized an empty wallet:
    // every part at offset 0, which the SDK reads as "stream from genesis". The
    // pre-seed then reported success while seeding nothing, and dust paid a full
    // chain walk on every new wallet.
    const unsubscribeProgress = onWarmProgress
      ? synced.subscribe((b) =>
          onWarmProgress({
            applied: b.subProgress.dust.applied,
            total: b.subProgress.dust.total,
            synced: b.synced,
          }),
        )
      : undefined;
    const reachedTip = await waitForTip(synced, REF_BUILD_TIMEOUT_MS);
    unsubscribeProgress?.();
    await synced.stop();

    if (!reachedTip) {
      // stop() persisted the partial state, so the next build resumes from it
      // rather than restarting. Refuse to hand it out in the meantime.
      onProgress?.('Pre-seed: reference did not reach chain tip in time — partial progress saved for the next attempt');
      return null;
    }

    // Record the height this reference represents, so callers can refuse to
    // seed wallets older than it. Read AFTER the sync finished: the tip may have
    // advanced past what the reference actually applied, which overstates the
    // height and therefore only ever makes the birthday check stricter.
    try {
      const tip = await new IndexerClient(network.indexerUrl).getBlock();
      if (tip?.height) await resolved.put(emptyRefHeightKey(network.id), String(tip.height));
    } catch {
      // Without a height the reference is unusable — better than guessing.
      onProgress?.('Pre-seed: could not record the reference height; reference will not be used');
    }

    // Re-read through the same usability check the warm path uses: reaching tip
    // is necessary but the serialized cursors are what actually get copied, so
    // verify them rather than trusting the sync's own verdict.
    const states = await loadUsableRefStates(resolved, network.id);
    if (!states) {
      onProgress?.('Pre-seed: reference sync completed but its state carries no chain cursor');
      return null;
    }

    // Record what these cursors point at now, so the next renumbering is
    // detectable rather than silent.
    const witnesses = await recordReferenceWitnesses(resolved, network, states, onProgress);

    // Keep this reference at its own height, witnesses included. Later builds
    // overwrite the live slot, so without the archive every past reference is
    // lost and a wallet born before the newest build has nothing to seed from —
    // and without the witnesses the archived copy could not be verified.
    await archiveReference(resolved, network.id, states.height, states, witnesses);

    onProgress?.(`Pre-seed: reference wallet ready at block ${states.height}`);
    return states;
  } catch (err) {
    onProgress?.(`Pre-seed: reference sync failed — ${err}`);
    return null;
  }
}

/**
 * Pre-seed a newly generated wallet's sync state from the empty reference.
 *
 * - Shielded: reference's Zswap tree + offset, new wallet's public keys, empty coins
 * - Unshielded: new wallet's public key, reference's indexer cursor, empty UTXOs
 * - Dust: reference state as-is with the new wallet's dust public key swapped in.
 *   Dust ledger events are global (the indexer streams `dustLedgerEvents` keyed
 *   by a global id), and a wallet holding no NIGHT has no designations of its
 *   own to preserve, so the reference's generation tree and cursor transfer
 *   directly. This is the expensive one to get right: without it dust walks the
 *   whole chain, which is minutes-to-an-hour where shielded takes seconds.
 */
export function preSeedNewWallet(
  walletKeys: WalletKeys,
  networkId: string,
  emptyRef: EmptyRefStates
): {shielded: string; unshielded: string; dust?: string} | null {
  try {
    setNetworkId(networkId);

    // Keys arrive pre-derived (Option A) — no seed to re-derive from.
    const shieldedSecretKeys = walletKeys.shieldedSecretKeys;
    const ks = createKeystore(walletKeys.nightExternalKey, networkId);
    const pk = PublicKey.fromKeyStore(ks);

    // Parse reference states
    const refSh = JSON.parse(emptyRef.shielded) as Record<string, unknown>;
    const refUn = JSON.parse(emptyRef.unshielded) as Record<string, unknown>;

    // Shielded: swap public keys, keep reference's tree + offset
    const shieldedSnap: Record<string, unknown> = {
      publicKeys: {
        coinPublicKey: shieldedSecretKeys.coinPublicKey,
        encryptionPublicKey: shieldedSecretKeys.encryptionPublicKey,
      },
      state: refSh.state,
      protocolVersion: refSh.protocolVersion,
      networkId,
      coinHashes: {},
    };
    if (refSh.offset !== undefined) shieldedSnap.offset = refSh.offset;

    // Unshielded: swap public key, keep reference's indexer cursor
    const unshieldedSnap: Record<string, unknown> = {
      publicKey: {publicKey: pk.publicKey, addressHex: pk.addressHex, address: pk.address},
      state: {availableUtxos: [], pendingUtxos: []},
      protocolVersion: refUn.protocolVersion,
      networkId,
    };
    if (refUn.appliedId !== undefined) unshieldedSnap.appliedId = refUn.appliedId;

    // Dust: For a new wallet with no NIGHT UTXOs, the reference dust state is
    // usable as-is — there are no wallet-specific designations to swap.
    // The dust wallet just needs the global generation tree at chain tip to
    // resume syncing from there instead of genesis.
    let dustSnap: string | undefined;
    try {
      const refDust = JSON.parse(emptyRef.dust) as Record<string, unknown>;
      // Swap in the new wallet's dust key, keep everything else. The public
      // key is a bigint; snapshots store it as a decimal string (JSON.stringify
      // throws on a raw bigint) — hence the .toString().
      dustSnap = JSON.stringify({
        publicKey: {publicKey: walletKeys.dustSecretKey.publicKey.toString()},
        state: refDust.state,
        protocolVersion: refDust.protocolVersion,
        networkId,
        offset: refDust.offset,
      });
    } catch {
      // Dust preseed failure is non-fatal — wallet will sync dust from genesis
    }

    return {
      shielded: JSON.stringify(shieldedSnap),
      unshielded: JSON.stringify(unshieldedSnap),
      dust: dustSnap,
    };
  } catch {
    return null;
  }
}

/** What a proposed birthday means for the first sync on this network. */
export interface BirthdayOutlook {
  /** True when a pre-seed will actually apply, so the sync starts near tip. */
  readonly seedable: boolean;
  /** Height of the reference available for this network, if any. */
  readonly referenceHeight: number | null;
  /** Human-readable reason when `seedable` is false. */
  readonly reason?: string;
}

/**
 * Whether a birthday will let the first sync use the reference.
 *
 * Worth asking *before* an import, because the answer is counter-intuitive: a
 * birthday that is too EARLY is refused, not accepted. The reference holds the
 * chain's state at its own height with no coins in it — it is not a record of
 * the blocks below that height and cannot be searched — so a wallet that might
 * have been active before it must scan those blocks itself.
 *
 * Without this the flags look like they worked: the birthday is stored, the
 * import succeeds, and the cost only shows up as a sync that takes an hour.
 */
export async function birthdayOutlook(
  network: NetworkConfig,
  birthday: number | undefined,
  store?: SyncStateStore,
): Promise<BirthdayOutlook> {
  const {height} = await preseedReferenceStatus(network, store);
  if (birthday === undefined) {
    return {seedable: false, referenceHeight: height, reason: 'no birthday — the first sync scans from genesis'};
  }
  if (height === null) {
    return {seedable: false, referenceHeight: null, reason: `no pre-seed reference for ${network.id} yet`};
  }
  if (height > birthday) {
    // The live reference is too new, but an archived one may sit below the
    // birthday. Report that height instead — it is the one the sync will use.
    const resolved = await resolveSyncStore(store);
    const archived = await loadArchivedRefStates(resolved, network.id, birthday);
    if (archived) return {seedable: true, referenceHeight: archived.height};
    return {
      seedable: false,
      referenceHeight: height,
      reason:
        `the newest reference for ${network.id} is at height ${height}, later than this birthday (${birthday}), ` +
        `and no archived reference sits at or below it. A reference holds no record of blocks below its own ` +
        `height, so those must still be scanned — the first sync will start from genesis.`,
    };
  }
  return {seedable: true, referenceHeight: height};
}
