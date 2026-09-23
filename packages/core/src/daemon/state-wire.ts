// The daemon's `getState` result, built from a WalletBalances snapshot.
//
// Pure and WASM-free, so the wire shape is unit-testable without a facade.
// Every bigint crosses as a decimal string and every Date as ISO-8601, per the
// convention in wallet-rpc-types.ts.
//
// This used to hand out three totals and a synced flag. That was enough to see
// that DUST was low and not enough to see why: `0.3 DUST` reads the same whether
// the wallet holds one small coin, one small coin plus a large one mid-spend, or
// one small coin and a large one it has lost sight of. The per-coin breakdown,
// the generation summary and the view health are what tell those apart, and
// wallet-sync had been building all three for the TUI already.

import type {
  DustCoinInfo,
  DustGeneration,
  DustViewHealth,
  ShieldedCoinInfo,
  SyncProgress,
  UnshieldedCoinInfo,
  WalletBalances,
} from '../sync/wallet-sync.js';
import type {
  DaemonDustCoinWire,
  DaemonDustGenerationWire,
  DaemonDustViewWire,
  DaemonGetStateResult,
  DaemonShieldedCoinWire,
  DaemonUnshieldedCoinWire,
} from './wallet-rpc-types.js';

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

export function serializeBigintRecord(r: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v.toString();
  return out;
}

export function dustCoinToWire(c: DustCoinInfo): DaemonDustCoinWire {
  return {
    generatedNow: c.generatedNow.toString(),
    maxCap: c.maxCap.toString(),
    maxCapReachedAt: iso(c.maxCapReachedAt) ?? new Date(0).toISOString(),
    dtime: iso(c.dtime),
    backingNight: c.backingNight ?? null,
    seq: c.seq ?? null,
    initialValue: c.initialValue?.toString() ?? null,
    ctime: iso(c.ctime),
  };
}

function shieldedCoinToWire(c: ShieldedCoinInfo): DaemonShieldedCoinWire {
  return {value: c.value.toString(), type: c.type};
}

function unshieldedCoinToWire(c: UnshieldedCoinInfo): DaemonUnshieldedCoinWire {
  return {
    value: c.value.toString(),
    type: c.type,
    registeredForDustGeneration: c.registeredForDustGeneration,
    ctime: c.ctimeMs === null ? null : new Date(c.ctimeMs).toISOString(),
  };
}

export function dustGenerationToWire(g: DustGeneration | null): DaemonDustGenerationWire | null {
  if (!g) return null;
  return {
    balance: g.balance.toString(),
    designated: g.designated.toString(),
    ratePerDay: g.ratePerDay.toString(),
    limit: g.limit.toString(),
    fillTime: iso(g.fillTime),
    numUtxos: g.numUtxos,
    registered: g.registered,
    registeredNight: g.registeredNight.toString(),
    newestRegisteredAt: iso(g.newestRegisteredAt),
  };
}

export function dustViewToWire(v: DustViewHealth | undefined): DaemonDustViewWire | null {
  if (!v) return null;
  return {
    status: v.status,
    checkedAt: v.checkedAt === null ? null : new Date(v.checkedAt).toISOString(),
    verdictAt: v.verdictAt === null ? null : new Date(v.verdictAt).toISOString(),
    complete: v.complete,
    lastError: v.lastError,
    missing: v.missing.map((m) => ({
      generationMtIndex: m.generationMtIndex,
      night: m.night.toString(),
      backingNight: m.backingNight,
      generatingSince: new Date(m.generatingSinceMs).toISOString(),
      missingSince: new Date(m.missingSinceMs).toISOString(),
    })),
    excluded: v.excluded,
    localApplied: v.localApplied,
    indexerMaxId: v.indexerMaxId,
    behindBy: v.behindBy,
    stalled: v.stalled,
    inconsistent: v.inconsistent,
    revertedSubmissions: v.revertedSubmissions,
    liveEntries: v.liveEntries,
    reason: v.reason,
  };
}

/** The `getState` result for a ready wallet. */
export function toGetStateResult(b: WalletBalances, meta: {walletName: string; networkId: string}): DaemonGetStateResult {
  const syncProgress: SyncProgress = b.syncProgress;
  return {
    ready: true,
    walletName: meta.walletName,
    networkId: meta.networkId,
    synced: b.synced,
    syncProgress,
    balances: {
      shielded: serializeBigintRecord(b.shielded),
      unshielded: serializeBigintRecord(b.unshielded),
      dust: b.dust.toString(),
    },
    coins: {
      shielded: {available: b.coins.shielded.available.map(shieldedCoinToWire), pending: b.coins.shielded.pending.map(shieldedCoinToWire)},
      unshielded: {
        available: b.coins.unshielded.available.map(unshieldedCoinToWire),
        pending: b.coins.unshielded.pending.map(unshieldedCoinToWire),
      },
      dust: {available: b.coins.dust.available.map(dustCoinToWire), pending: b.coins.dust.pending.map(dustCoinToWire)},
    },
    subProgress: b.subProgress,
    dustGeneration: dustGenerationToWire(b.dustGeneration),
    dustView: dustViewToWire(b.dustView),
  };
}
