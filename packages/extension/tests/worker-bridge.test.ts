import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest } from '../lib/offscreen/worker-rpc';

// The bridge spawns its workers through Vite's `?worker` import, which vitest
// cannot resolve; a stand-in records what each lane was asked and answers on cue.
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static spawned: FakeWorker[] = [];
    name: string;
    posted: WorkerRequest[] = [];
    terminated = false;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor(options: { name: string }) {
      this.name = options.name;
      FakeWorker.spawned.push(this);
    }
    postMessage(message: WorkerRequest): void {
      this.posted.push(message);
    }
    terminate(): void {
      this.terminated = true;
    }
    answer(id: number, result: unknown): void {
      this.onmessage?.({ data: { id, ok: true, result } });
    }
  }
  return { FakeWorker };
});
vi.mock('../lib/offscreen/wallet-worker?worker', () => ({ default: FakeWorker }));
vi.mock('../lib/offscreen/messaging', () => ({ offscreenSend: vi.fn().mockResolvedValue(undefined) }));

import { FAST_LANE_TIMEOUT_MS, PROVING_TIMEOUT_MS, hostRequest } from '../lib/offscreen/worker-bridge';

const lane = (name: string) => FakeWorker.spawned.find((w) => w.name === name && !w.terminated);

describe('worker bridge lanes', () => {
  beforeEach(() => {
    // The production branch: under `wxt dev` the host runs inline instead.
    vi.stubEnv('DEV', false);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // The failure Dust Dice users saw: the sync worker was mid cache restore — one
  // synchronous WASM call that runs for minutes — and the secret the user had just
  // approved waited behind it. The two lanes are separate threads, so a request on
  // the fast lane is answered while the sync lane is still silent.
  it('answers deriveAppSecret while the sync lane is blocked', async () => {
    const sync = hostRequest('os/syncEnsure', { seedHex: 'ab', walletName: 'w', network: {} as never });
    const syncWorker = lane('moth-wallet-host')!;
    expect(syncWorker.posted.map((m) => m.method)).toEqual(['os/syncEnsure']);

    const derive = hostRequest('os/deriveAppSecret', { seedHex: 'ab', origin: 'https://dapp.example', domain: 'd' });
    const fastWorker = lane('moth-wallet-fast')!;
    expect(fastWorker).not.toBe(syncWorker);
    expect(fastWorker.posted.map((m) => m.method)).toEqual(['os/deriveAppSecret']);

    // The sync lane never answers; the derive comes back regardless.
    fastWorker.answer(fastWorker.posted[0]!.id, { secret: 'ab'.repeat(32) });
    await expect(derive).resolves.toEqual({ secret: 'ab'.repeat(32) });

    syncWorker.answer(syncWorker.posted[0]!.id, undefined);
    await expect(sync).resolves.toBeUndefined();
  });

  // A worker Chrome killed for memory raises no event, so without a bound its
  // requests would sit until the page gave up ten minutes later.
  it('fails a silent fast-lane request loudly and respawns the lane', async () => {
    const derive = hostRequest('os/deriveAppSecret', { seedHex: 'ab', origin: 'https://dapp.example', domain: 'd' });
    const dead = lane('moth-wallet-fast')!;

    vi.advanceTimersByTime(FAST_LANE_TIMEOUT_MS);
    await expect(derive).rejects.toThrow(/did not answer os\/deriveAppSecret within 60s/);
    expect(dead.terminated).toBe(true);

    const next = hostRequest('os/txSummary', { network: {} as never, txHex: '', sealed: false });
    const fresh = lane('moth-wallet-fast')!;
    expect(fresh).not.toBe(dead);
    fresh.answer(fresh.posted[0]!.id, { spends: [], receives: [], contractActions: 0 });
    await expect(next).resolves.toEqual({ spends: [], receives: [], contractActions: 0 });
  });

  it('does not bound sync-lane work, which can legitimately run for minutes', async () => {
    const ensure = hostRequest('os/syncEnsure', { seedHex: 'ab', walletName: 'w', network: {} as never });
    const syncWorker = lane('moth-wallet-host')!;
    vi.advanceTimersByTime(PROVING_TIMEOUT_MS * 10);
    expect(syncWorker.terminated).toBe(false);
    syncWorker.answer(syncWorker.posted.at(-1)!.id, undefined);
    await expect(ensure).resolves.toBeUndefined();
  });

  // Two Dust Dice joins made 2.5 minutes apart were proved together 6.5 minutes
  // after the first: the proof requests sat on the sync lane behind a cold worker's
  // cache restore. The lanes are separate threads, so a proof is made while the
  // sync lane is still silent.
  it('proves a dApp transaction while the sync lane is blocked', async () => {
    const sync = hostRequest('os/syncEnsure', { seedHex: 'ab', walletName: 'w', network: {} as never });
    const syncWorker = lane('moth-wallet-host')!;
    const prove = hostRequest('os/provingProviderProve', { network: {} as never, payloadJson: '[]' });
    const fastWorker = lane('moth-wallet-fast')!;
    expect(fastWorker).not.toBe(syncWorker);
    expect(fastWorker.posted.at(-1)!.method).toBe('os/provingProviderProve');
    fastWorker.answer(fastWorker.posted.at(-1)!.id, 'proof-hex');
    await expect(prove).resolves.toBe('proof-hex');
    syncWorker.answer(syncWorker.posted.at(-1)!.id, undefined);
    await expect(sync).resolves.toBeUndefined();
  });

  // A proof legitimately outlasts the 60 s bound (the proof server path alone allows
  // five minutes per request), but a proof server that never answers must still end
  // in an error the dApp can show, before the page gives up at ten minutes.
  it('gives a proof its own longer bound and fails it loudly after that', async () => {
    const prove = hostRequest('os/provingProviderProve', { network: {} as never, payloadJson: '[]' });
    const fastWorker = lane('moth-wallet-fast')!;
    vi.advanceTimersByTime(FAST_LANE_TIMEOUT_MS * 3);
    expect(fastWorker.terminated).toBe(false);
    vi.advanceTimersByTime(PROVING_TIMEOUT_MS - FAST_LANE_TIMEOUT_MS * 3);
    await expect(prove).rejects.toThrow(/did not answer os\/provingProviderProve within 360s/);
    expect(fastWorker.terminated).toBe(true);
  });

  it('clears the bound once a fast-lane request is answered', async () => {
    const list = hostRequest('os/walletList', { network: 'devnet' });
    const fastWorker = lane('moth-wallet-fast')!;
    fastWorker.answer(fastWorker.posted.at(-1)!.id, []);
    await expect(list).resolves.toEqual([]);
    vi.advanceTimersByTime(FAST_LANE_TIMEOUT_MS * 2);
    expect(fastWorker.terminated).toBe(false);
  });
});
