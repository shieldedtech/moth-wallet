// Keeps request-meter figures alive across the offscreen document's lifetime.
//
// The meter lives at module scope in the offscreen worker, so it dies whenever
// that document is closed — which `teardown` does on every lock, and auto-lock
// fires at fifteen minutes by default. Before this, the debug page's request
// section simply vanished at that point: the handler returns null when the
// document is down, and the page unmounts the whole section on null. A counter
// that resets every time the wallet locks cannot answer "how many 403s have I
// had today", which is the only question it was built for.
//
// So the background retains a baseline. Each time the live meter is read, the
// snapshot is remembered; when a *new* meter appears (a different start time),
// the last thing the old one said is folded into the baseline and the totals
// carry on across the gap.
//
// Held in storage.session, deliberately: it is memory-only and never written to
// disk, which matters because the retained failures carry request bodies. It
// clears when the browser does.

import { browser } from 'wxt/browser';
import type { HostStats, MeterSnapshot, RequestFailure } from '../offscreen/request-meter';
import { MAX_FAILURES } from '../offscreen/request-meter';

const KEY = 'debugRetainedRequestStats';

/** Per-host figures that survive a meter, keyed by host. Rates are absent on
 *  purpose: a rate has no meaning once the window that produced it is gone. */
export interface RetainedHost {
  totalAllTime: number;
  byStatus: HostStats['byStatus'];
  statusCounts: Record<string, number>;
  sockets: HostStats['sockets'];
  peakPerSecond: number;
  peakAt: number | null;
  /** Absolute time of the last request, so staleness survives the meter that
   *  measured it. */
  lastAt: number;
}

export interface RetainedStats {
  hosts: Record<string, RetainedHost>;
  failures: RequestFailure[];
  /** Total time meters have been running, across all of them. */
  uptimeMs: number;
  /** `at - uptimeMs` of the meter last seen, identifying its generation. A
   *  different value means the offscreen document restarted. */
  lastMeterStartedAt: number | null;
  /** The last snapshot that generation produced, not yet folded in. Held so a
   *  meter's final moments are not lost when it dies unobserved. */
  pending: MeterSnapshot | null;
}

export const EMPTY: RetainedStats = {
  hosts: {},
  failures: [],
  uptimeMs: 0,
  lastMeterStartedAt: null,
  pending: null,
};

const emptyHost = (): RetainedHost => ({
  totalAllTime: 0,
  byStatus: { ok: 0, forbidden: 0, otherClientError: 0, serverError: 0, failed: 0 },
  statusCounts: {},
  sockets: { opened: 0, neverOpened: 0, closed: 0, closeCodes: {} },
  peakPerSecond: 0,
  peakAt: null,
  lastAt: 0,
});

/** Add one meter's figures to the baseline. Counts sum; the peak is a max, not a
 *  sum — two separate bursts of 30 are a peak of 30, never 60. */
export function fold(base: RetainedStats, snap: MeterSnapshot): RetainedStats {
  const hosts = { ...base.hosts };
  for (const h of snap.hosts) {
    const prev = hosts[h.host] ?? emptyHost();
    const statusCounts = { ...prev.statusCounts };
    for (const [code, n] of Object.entries(h.statusCounts)) statusCounts[code] = (statusCounts[code] ?? 0) + n;
    const closeCodes = { ...prev.sockets.closeCodes };
    for (const [code, n] of Object.entries(h.sockets.closeCodes)) closeCodes[code] = (closeCodes[code] ?? 0) + n;
    hosts[h.host] = {
      totalAllTime: prev.totalAllTime + h.totalAllTime,
      byStatus: {
        ok: prev.byStatus.ok + h.byStatus.ok,
        forbidden: prev.byStatus.forbidden + h.byStatus.forbidden,
        otherClientError: prev.byStatus.otherClientError + h.byStatus.otherClientError,
        serverError: prev.byStatus.serverError + h.byStatus.serverError,
        failed: prev.byStatus.failed + h.byStatus.failed,
      },
      statusCounts,
      sockets: {
        opened: prev.sockets.opened + h.sockets.opened,
        neverOpened: prev.sockets.neverOpened + h.sockets.neverOpened,
        closed: prev.sockets.closed + h.sockets.closed,
        closeCodes,
      },
      peakPerSecond: Math.max(prev.peakPerSecond, h.peakPerSecond),
      peakAt: h.peakPerSecond > prev.peakPerSecond ? h.peakAt : prev.peakAt,
      lastAt: Math.max(prev.lastAt, h.sinceLastMs === null ? 0 : snap.at - h.sinceLastMs),
    };
  }
  // Newest first across both, capped — the same rule the meter itself applies.
  const failures = [...snap.failures, ...base.failures]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FAILURES);
  return {
    hosts,
    failures,
    uptimeMs: base.uptimeMs + snap.uptimeMs,
    lastMeterStartedAt: base.lastMeterStartedAt,
    pending: base.pending,
  };
}

/**
 * Reconcile the baseline with whatever the live meter says now.
 *
 * The generation check is the load-bearing part. A meter that is still the one
 * we saw last time has its figures counted live, so its previous snapshot must
 * NOT be folded in — that would double every request on every poll. Only when
 * the start time changes has a meter died, and only then is its last known
 * state absorbed.
 */
export function reconcile(base: RetainedStats, live: MeterSnapshot | null): RetainedStats {
  if (!live) return base;
  const startedAt = live.at - live.uptimeMs;
  if (base.lastMeterStartedAt === startedAt) {
    return { ...base, pending: live };
  }
  // A new meter. Absorb the outgoing one's last word, then track this one.
  const folded = base.pending ? fold(base, base.pending) : base;
  return { ...folded, lastMeterStartedAt: startedAt, pending: live };
}

/**
 * The snapshot the debug page renders: retained history plus the live window.
 *
 * Returns hosts even with no live meter — with zeroed rates and an empty
 * window, which is exactly the honest reading of "the wallet is locked and
 * nothing is being requested right now".
 */
export function present(base: RetainedStats, live: MeterSnapshot | null, at: number): MeterSnapshot {
  const liveByHost = new Map((live?.hosts ?? []).map((h) => [h.host, h]));
  const names = new Set([...Object.keys(base.hosts), ...liveByHost.keys()]);

  const hosts: HostStats[] = [];
  for (const host of names) {
    const prev = base.hosts[host] ?? emptyHost();
    const now = liveByHost.get(host);
    const merged = now ? fold({ ...EMPTY, hosts: { [host]: prev } }, { ...live!, hosts: [now], failures: [] }) : null;
    const h = merged ? merged.hosts[host]! : prev;
    hosts.push({
      host,
      total: now?.total ?? 0,
      totalAllTime: h.totalAllTime,
      byStatus: h.byStatus,
      statusCounts: h.statusCounts,
      perSecond: now?.perSecond ?? 0,
      perSecondAvg60: now?.perSecondAvg60 ?? 0,
      peakPerSecond: h.peakPerSecond,
      peakAt: h.peakAt,
      sockets: h.sockets,
      sinceLastMs: h.lastAt > 0 ? at - h.lastAt : null,
    });
  }
  hosts.sort((a, b) => b.totalAllTime - a.totalAllTime);

  const failures = [...(live?.failures ?? []), ...base.failures]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FAILURES);

  return {
    at,
    uptimeMs: base.uptimeMs + (live?.uptimeMs ?? 0),
    hosts,
    totalInWindow: live?.totalInWindow ?? 0,
    failures,
  };
}

function session(): { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void> } {
  return browser.storage.session as never;
}

export async function load(): Promise<RetainedStats> {
  try {
    const stored = await session().get(KEY);
    return (stored[KEY] as RetainedStats | undefined) ?? EMPTY;
  } catch {
    return EMPTY; // a diagnostic must never be the thing that breaks
  }
}

export async function save(stats: RetainedStats): Promise<void> {
  try {
    await session().set({ [KEY]: stats });
  } catch {
    /* best effort */
  }
}

export async function clear(): Promise<void> {
  try {
    await session().remove(KEY);
  } catch {
    /* best effort */
  }
}
