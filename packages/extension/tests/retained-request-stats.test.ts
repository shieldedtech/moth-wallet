import { describe, expect, it } from 'vitest';
import { EMPTY, fold, present, reconcile, type RetainedStats } from '../lib/background/retained-request-stats';
import type { HostStats, MeterSnapshot } from '../lib/offscreen/request-meter';

function host(over: Partial<HostStats> & { host: string }): HostStats {
  return {
    total: 0,
    totalAllTime: 0,
    byStatus: { ok: 0, forbidden: 0, otherClientError: 0, serverError: 0, failed: 0 },
    statusCounts: {},
    perSecond: 0,
    perSecondAvg60: 0,
    peakPerSecond: 0,
    peakAt: null,
    sockets: { opened: 0, neverOpened: 0, closed: 0, closeCodes: {} },
    sinceLastMs: null,
    ...over,
  };
}

/** A meter that started `uptimeMs` before `at`. The pair identifies a generation. */
function snap(at: number, uptimeMs: number, hosts: HostStats[]): MeterSnapshot {
  return { at, uptimeMs, hosts, totalInWindow: hosts.reduce((n, h) => n + h.total, 0), failures: [] };
}

// The offscreen document is closed on every lock, taking the meter with it. The
// question these answer is whether the figures survive that, and — the more
// dangerous half — whether they survive it without being counted twice.
describe('reconcile', () => {
  const live = snap(10_000, 5_000, [host({ host: 'rpc.example', totalAllTime: 7 })]);

  it('does not fold a meter that is still running', () => {
    // Polled every 2s. If each poll folded the live figures in, a wallet idle
    // for a minute would report thirty times the requests it made.
    let state: RetainedStats = EMPTY;
    for (let i = 0; i < 10; i++) {
      state = reconcile(state, snap(10_000 + i * 2_000, 5_000 + i * 2_000, live.hosts));
    }
    expect(present(state, live, 10_000).hosts[0]!.totalAllTime).toBe(7);
  });

  it('absorbs the outgoing meter when a new one appears', () => {
    let state = reconcile(EMPTY, live);
    // Lock, unlock: a fresh meter, its own uptime restarted from zero.
    const reborn = snap(100_000, 1_000, [host({ host: 'rpc.example', totalAllTime: 2 })]);
    state = reconcile(state, reborn);
    expect(present(state, reborn, 100_000).hosts[0]!.totalAllTime).toBe(9); // 7 + 2
  });

  it('survives a generation that was never seen again', () => {
    // The meter dies between polls; its last snapshot is all that is left.
    let state = reconcile(EMPTY, live);
    state = reconcile(state, null); // offscreen down — nothing to reconcile
    const reborn = snap(200_000, 500, []);
    state = reconcile(state, reborn);
    expect(present(state, reborn, 200_000).hosts[0]!.totalAllTime).toBe(7);
  });
});

describe('present', () => {
  it('reports a host with no live meter at all', () => {
    // The wallet is locked. This is the case that used to render nothing.
    const state = reconcile(
      EMPTY,
      snap(10_000, 5_000, [
        host({ host: 'rpc.example', totalAllTime: 4, byStatus: { ok: 2, forbidden: 2, otherClientError: 0, serverError: 0, failed: 0 }, sinceLastMs: 1_000 }),
      ]),
    );
    const folded = reconcile(state, snap(20_000, 1_000, [])); // new empty meter
    const out = present(folded, null, 60_000);

    expect(out.hosts).toHaveLength(1);
    expect(out.hosts[0]!.totalAllTime).toBe(4);
    expect(out.hosts[0]!.byStatus.forbidden).toBe(2); // the reason you are here
    expect(out.hosts[0]!.total).toBe(0); // nothing in the window
    expect(out.hosts[0]!.perSecond).toBe(0);
    expect(out.hosts[0]!.sinceLastMs).toBe(51_000); // and this says how old it is
  });

  it('keeps the peak as a maximum, never a sum', () => {
    // Two bursts of 30 are a peak of 30. Summing them would invent a burst that
    // never happened, in the one number someone would take to an operator.
    let state = reconcile(EMPTY, snap(10_000, 5_000, [host({ host: 'rpc.example', peakPerSecond: 30, peakAt: 9_000 })]));
    const second = snap(50_000, 1_000, [host({ host: 'rpc.example', peakPerSecond: 30, peakAt: 49_000 })]);
    state = reconcile(state, second);
    expect(present(state, second, 50_000).hosts[0]!.peakPerSecond).toBe(30);
  });

  it('prefers the larger peak and reports when it happened', () => {
    let state = reconcile(EMPTY, snap(10_000, 5_000, [host({ host: 'rpc.example', peakPerSecond: 12, peakAt: 9_000 })]));
    const bigger = snap(50_000, 1_000, [host({ host: 'rpc.example', peakPerSecond: 40, peakAt: 49_000 })]);
    state = reconcile(state, bigger);
    const out = present(state, bigger, 50_000).hosts[0]!;
    expect(out.peakPerSecond).toBe(40);
    expect(out.peakAt).toBe(49_000);
  });

  it('sums outcomes across generations without double counting the live one', () => {
    let state = reconcile(EMPTY, snap(10_000, 5_000, [
      host({ host: 'rpc.example', totalAllTime: 3, byStatus: { ok: 1, forbidden: 2, otherClientError: 0, serverError: 0, failed: 0 }, statusCounts: { '200': 1, '403': 2 } }),
    ]));
    const live = snap(90_000, 2_000, [
      host({ host: 'rpc.example', total: 1, totalAllTime: 1, byStatus: { ok: 0, forbidden: 1, otherClientError: 0, serverError: 0, failed: 0 }, statusCounts: { '403': 1 } }),
    ]);
    state = reconcile(state, live);
    const out = present(state, live, 90_000).hosts[0]!;
    expect(out.byStatus.forbidden).toBe(3);
    expect(out.statusCounts).toEqual({ '200': 1, '403': 3 });
    expect(out.total).toBe(1); // window is live-only
  });

  it('is empty before anything has been recorded', () => {
    expect(present(EMPTY, null, 1_000).hosts).toEqual([]);
  });
});

describe('fold', () => {
  it('keeps the newest failures across meters', () => {
    const base: RetainedStats = {
      ...EMPTY,
      failures: [{ at: 5, method: 'GET', url: 'https://a/', headers: {}, body: null, status: 403, statusText: '', responseBody: null }],
    };
    const out = fold(base, {
      ...snap(10, 10, []),
      failures: [{ at: 9, method: 'GET', url: 'https://b/', headers: {}, body: null, status: 500, statusText: '', responseBody: null }],
    });
    expect(out.failures.map((f) => f.at)).toEqual([9, 5]); // newest first
  });
});
