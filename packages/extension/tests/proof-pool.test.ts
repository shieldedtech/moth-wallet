import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProofPool, defaultPoolSize, MAX_PROOF_WORKERS, type ProofWorkerLike } from '../lib/offscreen/proof-pool';
import type { PoolToWorker, WorkerToPool } from '../lib/offscreen/proof-rpc';
import type { WasmKeyMaterialProvider } from '@shieldedtech/moth-browser';

// A scriptable stand-in for a proof worker: records what the pool posts and lets
// a test play the worker's side (key requests, results, errors) by hand.
class FakeWorker implements ProofWorkerLike {
  static all: FakeWorker[] = [];
  posted: PoolToWorker[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<WorkerToPool>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: PoolToWorker) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** The pool's job requests (not key replies) so far. */
  jobs() {
    return this.posted.filter((m) => 'op' in m);
  }
  emit(message: WorkerToPool) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerToPool>);
  }
  crash(message = 'boom') {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const keys: WasmKeyMaterialProvider = {
  lookupKey: vi.fn(async (location: string) => ({
    proverKey: new Uint8Array([1]),
    verifierKey: new Uint8Array([2]),
    ir: new Uint8Array([location.length]),
  })),
  getParams: vi.fn(async (k: number) => new Uint8Array([k])),
};

const preimage = new Uint8Array([9, 9, 9]);
// The zswap spend circuit's key location, as zkir asks for it.
const SPEND_CIRCUIT = 'midnight/zswap/spend';
// Fake timers are on, so drain microtasks by hand rather than via setTimeout.
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('proof pool', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs concurrent proofs on separate workers, up to the pool size, and queues the rest', () => {
    const pool = createProofPool({ size: 2, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);

    void provider.prove(preimage, 'a');
    void provider.prove(preimage, 'b');
    void provider.prove(preimage, 'c');

    // Two workers, one job each; the third waits.
    expect(pool.workers).toBe(2);
    expect(FakeWorker.all[0]!.jobs()).toHaveLength(1);
    expect(FakeWorker.all[1]!.jobs()).toHaveLength(1);

    // Finishing one frees its worker for the queued job — no third worker.
    const first = FakeWorker.all[0]!;
    const job = first.jobs()[0] as { id: number };
    first.emit({ id: job.id, ok: true, result: new Uint8Array([1]) });
    expect(pool.workers).toBe(2);
    expect(first.jobs()).toHaveLength(2);
  });

  it('resolves prove with the worker result and check with its list', async () => {
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);

    const proof = provider.prove(preimage, 'x', 7n);
    const worker = FakeWorker.all[0]!;
    const job = worker.jobs()[0] as { id: number; op: string; overwriteBindingInput?: bigint };
    expect(job.op).toBe('prove');
    expect(job.overwriteBindingInput).toBe(7n);
    worker.emit({ id: job.id, ok: true, result: new Uint8Array([4, 2]) });
    await expect(proof).resolves.toEqual(new Uint8Array([4, 2]));

    const checked = provider.check(preimage, 'x');
    const checkJob = worker.jobs()[1] as { id: number; op: string };
    expect(checkJob.op).toBe('check');
    worker.emit({ id: checkJob.id, ok: true, result: [1n, undefined] });
    await expect(checked).resolves.toEqual([1n, undefined]);
  });

  it("answers a worker's key requests from the job's own key material", async () => {
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    void pool.provider(keys).prove(preimage, 'x');
    const worker = FakeWorker.all[0]!;
    const job = worker.jobs()[0] as { id: number };

    worker.emit({ id: job.id, reqId: 1, req: 'lookupKey', keyLocation: SPEND_CIRCUIT });
    worker.emit({ id: job.id, reqId: 2, req: 'getParams', k: 14 });
    await flush();

    expect(keys.lookupKey).toHaveBeenCalledWith(SPEND_CIRCUIT);
    expect(keys.getParams).toHaveBeenCalledWith(14);
    const replies = worker.posted.filter((m) => 'reqId' in m) as Array<{ reqId: number; ok: boolean; result: unknown }>;
    expect(replies.map((r) => r.reqId)).toEqual([1, 2]);
    expect(replies[0]!.ok).toBe(true);
    expect((replies[0]!.result as { ir: Uint8Array }).ir).toEqual(new Uint8Array([SPEND_CIRCUIT.length]));
    expect(replies[1]!.result).toEqual(new Uint8Array([14]));
  });

  it('relays a key lookup failure to the worker instead of hanging it', async () => {
    const failing: WasmKeyMaterialProvider = {
      lookupKey: async () => {
        throw new Error('S3 unreachable');
      },
      getParams: async () => new Uint8Array(),
    };
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    void pool.provider(failing).prove(preimage, 'x');
    const worker = FakeWorker.all[0]!;
    const job = worker.jobs()[0] as { id: number };

    worker.emit({ id: job.id, reqId: 1, req: 'lookupKey', keyLocation: SPEND_CIRCUIT });
    await flush();

    const reply = worker.posted.find((m) => 'reqId' in m) as { ok: boolean; error: { message: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error.message).toBe('S3 unreachable');
  });

  it('rejects with the reconstructed error when the worker reports a failed proof', async () => {
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    const proof = pool.provider(keys).prove(preimage, 'x');
    const worker = FakeWorker.all[0]!;
    const job = worker.jobs()[0] as { id: number };

    worker.emit({ id: job.id, ok: false, error: { name: 'Error', message: 'bad preimage', stack: '' } });

    await expect(proof).rejects.toThrow('bad preimage');
  });

  it('fails the running job when a worker errors, drops that worker, and spawns a fresh one next time', async () => {
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);
    const proof = provider.prove(preimage, 'x');
    const first = FakeWorker.all[0]!;

    first.crash('script error');

    await expect(proof).rejects.toThrow(/Proof worker failed/);
    expect(first.terminated).toBe(true);
    expect(pool.workers).toBe(0);

    void provider.prove(preimage, 'y');
    expect(FakeWorker.all).toHaveLength(2);
    expect(pool.workers).toBe(1);
  });

  it('retires idle workers after the idle period and respawns on demand', () => {
    const pool = createProofPool({ size: 1, idleMs: 1_000, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);
    void provider.prove(preimage, 'x');
    const worker = FakeWorker.all[0]!;
    const job = worker.jobs()[0] as { id: number };
    worker.emit({ id: job.id, ok: true, result: new Uint8Array() });

    vi.advanceTimersByTime(999);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(worker.terminated).toBe(true);
    expect(pool.workers).toBe(0);

    void provider.prove(preimage, 'y');
    expect(pool.workers).toBe(1);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('does not retire a worker that picked up a new job during its idle window', () => {
    const pool = createProofPool({ size: 1, idleMs: 1_000, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);
    void provider.prove(preimage, 'x');
    const worker = FakeWorker.all[0]!;
    worker.emit({ id: (worker.jobs()[0] as { id: number }).id, ok: true, result: new Uint8Array() });

    vi.advanceTimersByTime(500);
    void provider.prove(preimage, 'y'); // reuses the idle worker, cancels its clock
    vi.advanceTimersByTime(1_000);

    expect(worker.terminated).toBe(false);
    expect(worker.jobs()).toHaveLength(2);
  });

  it('close() terminates every worker and rejects queued and running jobs', async () => {
    const pool = createProofPool({ size: 1, spawn: () => new FakeWorker() });
    const provider = pool.provider(keys);
    const running = provider.prove(preimage, 'x');
    const queued = provider.prove(preimage, 'y');

    pool.close();

    await expect(running).rejects.toThrow('Proof pool is closed');
    await expect(queued).rejects.toThrow('Proof pool is closed');
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    await expect(provider.prove(preimage, 'z')).rejects.toThrow('Proof pool is closed');
  });
});

describe('defaultPoolSize', () => {
  it('leaves one thread for the wallet worker, caps at the maximum, never drops below one', () => {
    expect(defaultPoolSize(2)).toBe(1);
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(4)).toBe(3);
    expect(defaultPoolSize(16)).toBe(MAX_PROOF_WORKERS);
  });
});
