// A pool of proof workers behind the ledger's ProvingProvider: the ledger requests a
// transaction's proofs concurrently, so each gets its own thread instead of queueing
// on the in-thread prover. Key material stays here, fetched and cached once.

import type { ProvingProvider } from '@midnightntwrk/ledger-v8';
import type { WasmKeyMaterialProvider, ZkirVersion } from '@shieldedtech/moth-browser';
import { deserializeHostError, serializeHostError } from './worker-rpc';
import { isKeyRequest, type KeyRequest, type PoolToWorker, type ProofJobResult, type ProofOp, type WorkerToPool } from './proof-rpc';
// No `?worker` import here: the caller (wallet-host.ts) supplies `spawn`, so this
// module resolves under vitest and the pool's scheduling is unit-tested.

/** The surface of a Worker the pool relies on — narrow so tests can fake it. */
export interface ProofWorkerLike {
  postMessage(message: PoolToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerToPool>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ProofPoolOptions {
  /** Max concurrent proof workers. Default: defaultPoolSize(). */
  size?: number;
  /** Worker factory — production passes the `?worker` constructor, tests a fake. */
  spawn: () => ProofWorkerLike;
  /** How long an idle worker is kept before its WASM heap is released. */
  idleMs?: number;
  /** How long one key or parameter lookup may take before the job is failed. */
  keyTimeoutMs?: number;
  /** How long one job may run, lookups included, before its worker is terminated. */
  jobTimeoutMs?: number;
  /** Diagnostic lines; tests capture them. Default: console.info. */
  log?: (line: string) => void;
}

export interface ProofPool {
  /** A ledger ProvingProvider whose proofs run on the pool with this key source and zkir. */
  provider(keyMaterial: WasmKeyMaterialProvider, zkir: ZkirVersion): ProvingProvider;
  /** Terminate every worker; queued and running jobs reject. */
  close(): void;
  readonly size: number;
  /** Workers currently alive (for tests and diagnostics). */
  readonly workers: number;
}

// Each proof worker peaks at a few hundred MB, so the pool is capped well below the
// core count; four covers a transfer's proofs.
export const MAX_PROOF_WORKERS = 4;
const DEFAULT_IDLE_MS = 30_000;
// A wallet proof takes well under a minute in WASM and its keys are a few MB, so these
// only fire on a stall, which otherwise leaves the send on "Generating proof" forever.
export const DEFAULT_KEY_TIMEOUT_MS = 120_000;
export const DEFAULT_JOB_TIMEOUT_MS = 300_000;
const LOG_PREFIX = '[moth proof]';

/** One thread short of the machine, capped, never below one. */
export function defaultPoolSize(hardwareConcurrency: number = globalThis.navigator?.hardwareConcurrency ?? 2): number {
  return Math.max(1, Math.min(MAX_PROOF_WORKERS, hardwareConcurrency - 1));
}

interface Job {
  id: number;
  op: ProofOp;
  zkir: ZkirVersion;
  preimage: Uint8Array;
  overwriteBindingInput?: bigint;
  keyMaterial: WasmKeyMaterialProvider;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  startedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Lookups asked for and not yet answered, so a timeout can say what it was waiting on. */
  pendingKeys: Set<string>;
  /**
   * Whether the worker has sent anything for this job. zkir asks for a key within
   * moments of starting, so a job that times out without ever hearing from its
   * worker was never run (the worker dropped it or died), not slow to prove.
   */
  heard: boolean;
}

interface Slot {
  worker: ProofWorkerLike;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const describeKey = (request: KeyRequest): string =>
  request.req === 'lookupKey' ? `key ${request.keyLocation}` : `params k=${request.k}`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createProofPool(options: ProofPoolOptions): ProofPool {
  const size = options.size ?? defaultPoolSize();
  const spawn = options.spawn;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const keyTimeoutMs = options.keyTimeoutMs ?? DEFAULT_KEY_TIMEOUT_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const log = (line: string) => (options.log ?? console.info)(`${LOG_PREFIX} ${line}`);
  const elapsed = (job: Job) => `${((Date.now() - (job.startedAt ?? Date.now())) / 1000).toFixed(1)} s`;
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;

  // The pool holds the key material; the worker asks per lookup.
  async function answerKey(slot: Slot, request: KeyRequest): Promise<void> {
    const job = slot.job;
    if (!job || job.id !== request.id) return; // a reply for a job that already ended
    const reply = (message: PoolToWorker) => {
      // The worker may have been retired while the lookup was in flight.
      if (slot.job === job) slot.worker.postMessage(message);
    };
    job.heard = true;
    const what = describeKey(request);
    const asked = Date.now();
    job.pendingKeys.add(what);
    try {
      const lookup =
        request.req === 'lookupKey'
          ? job.keyMaterial.lookupKey(request.keyLocation)
          : job.keyMaterial.getParams(request.k);
      const result = await withTimeout<unknown>(lookup, keyTimeoutMs, `Proof job ${job.id}: ${what}`);
      log(`job ${job.id}: ${what} answered in ${Date.now() - asked} ms`);
      reply({ id: request.id, reqId: request.reqId, ok: true, result });
    } catch (err) {
      log(`job ${job.id}: ${what} failed after ${Date.now() - asked} ms: ${err instanceof Error ? err.message : String(err)}`);
      reply({ id: request.id, reqId: request.reqId, ok: false, error: serializeHostError(err) });
    } finally {
      job.pendingKeys.delete(what);
    }
  }

  function settle(job: Job): void {
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = undefined;
  }

  function finish(slot: Slot, result: ProofJobResult): void {
    const job = slot.job;
    if (!job || job.id !== result.id) return;
    slot.job = null;
    settle(job);
    log(`job ${job.id}: ${job.op} ${result.ok ? 'done' : 'failed'} in ${elapsed(job)}`);
    if (result.ok) job.resolve(result.result);
    else job.reject(deserializeHostError(result.error));
    pump();
  }

  // A worker that errors is unusable: drop it, fail its job loudly, respawn on demand.
  function fail(slot: Slot, error: Error): void {
    const job = slot.job;
    if (job) settle(job);
    retire(slot);
    job?.reject(error);
    pump();
  }

  // A stalled job holds its worker forever, so terminate the worker rather than wait on it.
  function expire(slot: Slot, job: Job): void {
    if (slot.job !== job) return;
    const state =
      job.pendingKeys.size > 0
        ? `it was waiting on ${[...job.pendingKeys].join(', ')}`
        : job.heard
          ? 'it was proving'
          : 'the proof worker never responded to it';
    const error = new Error(`Proof job ${job.id} (${job.op}) gave no result within ${jobTimeoutMs / 1000} s; ${state}`);
    log(error.message);
    fail(slot, error);
  }

  function retire(slot: Slot): void {
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.job = null;
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.terminate();
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
  }

  function attach(worker: ProofWorkerLike): Slot {
    const slot: Slot = { worker, job: null, idleTimer: null };
    worker.onmessage = (event) => {
      const message = event.data;
      if (isKeyRequest(message)) void answerKey(slot, message);
      else finish(slot, message);
    };
    worker.onerror = (event) => fail(slot, new Error(`Proof worker failed: ${event.message || 'script error'}`));
    slots.push(slot);
    return slot;
  }

  function pump(): void {
    if (closed) return;
    while (queue.length > 0) {
      let slot = slots.find((candidate) => candidate.job === null);
      if (!slot && slots.length < size) slot = attach(spawn());
      if (!slot) break; // every worker busy — the job waits its turn
      const job = queue.shift()!;
      if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
      slot.job = job;
      job.startedAt = Date.now();
      const assigned = slot;
      job.timer = setTimeout(() => expire(assigned, job), jobTimeoutMs);
      log(`job ${job.id}: ${job.op} started (zkir ${job.zkir}, ${queue.length} queued, ${slots.length} workers)`);
      slot.worker.postMessage({
        id: job.id,
        op: job.op,
        zkir: job.zkir,
        preimage: job.preimage,
        overwriteBindingInput: job.overwriteBindingInput,
      });
    }
    // Whatever is idle now gets its retirement clock.
    for (const slot of slots) {
      if (slot.job === null && slot.idleTimer === null) {
        slot.idleTimer = setTimeout(() => {
          if (slot.job === null) retire(slot);
        }, idleMs);
      }
    }
  }

  function submit(
    op: ProofOp,
    zkir: ZkirVersion,
    preimage: Uint8Array,
    keyMaterial: WasmKeyMaterialProvider,
    overwriteBindingInput?: bigint,
  ): Promise<unknown> {
    if (closed) return Promise.reject(new Error('Proof pool is closed'));
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, op, zkir, preimage, overwriteBindingInput, keyMaterial, resolve, reject, pendingKeys: new Set(), heard: false });
      pump();
    });
  }

  return {
    provider(keyMaterial, zkir) {
      return {
        check: (preimage) => submit('check', zkir, preimage, keyMaterial) as Promise<(bigint | undefined)[]>,
        prove: (preimage, _keyLocation, overwriteBindingInput) =>
          submit('prove', zkir, preimage, keyMaterial, overwriteBindingInput) as Promise<Uint8Array>,
      };
    },
    close() {
      closed = true;
      const error = new Error('Proof pool is closed');
      for (const slot of [...slots]) {
        const job = slot.job;
        if (job) settle(job);
        retire(slot);
        job?.reject(error);
      }
      for (const job of queue.splice(0)) job.reject(error);
    },
    get size() {
      return size;
    },
    get workers() {
      return slots.length;
    },
  };
}
