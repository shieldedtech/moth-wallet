// A pool of proof workers behind the ledger's ProvingProvider: the ledger requests a
// transaction's proofs concurrently, so each gets its own thread instead of queueing
// on the in-thread prover. Key material stays here, fetched and cached once.

import type { ProvingProvider } from '@midnight-ntwrk/ledger-v8';
import type { WasmKeyMaterialProvider } from '@shieldedtech/moth-browser';
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
}

export interface ProofPool {
  /** A ledger ProvingProvider whose proofs run on the pool with this key source. */
  provider(keyMaterial: WasmKeyMaterialProvider): ProvingProvider;
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

/** One thread short of the machine, capped, never below one. */
export function defaultPoolSize(hardwareConcurrency: number = globalThis.navigator?.hardwareConcurrency ?? 2): number {
  return Math.max(1, Math.min(MAX_PROOF_WORKERS, hardwareConcurrency - 1));
}

interface Job {
  id: number;
  op: ProofOp;
  preimage: Uint8Array;
  overwriteBindingInput?: bigint;
  keyMaterial: WasmKeyMaterialProvider;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Slot {
  worker: ProofWorkerLike;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function createProofPool(options: ProofPoolOptions): ProofPool {
  const size = options.size ?? defaultPoolSize();
  const spawn = options.spawn;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
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
    try {
      const result =
        request.req === 'lookupKey'
          ? await job.keyMaterial.lookupKey(request.keyLocation)
          : await job.keyMaterial.getParams(request.k);
      reply({ id: request.id, reqId: request.reqId, ok: true, result });
    } catch (err) {
      reply({ id: request.id, reqId: request.reqId, ok: false, error: serializeHostError(err) });
    }
  }

  function finish(slot: Slot, result: ProofJobResult): void {
    const job = slot.job;
    if (!job || job.id !== result.id) return;
    slot.job = null;
    if (result.ok) job.resolve(result.result);
    else job.reject(deserializeHostError(result.error));
    pump();
  }

  // A worker that errors is unusable: drop it, fail its job loudly, respawn on demand.
  function fail(slot: Slot, error: Error): void {
    const job = slot.job;
    retire(slot);
    job?.reject(error);
    pump();
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
      slot.worker.postMessage({ id: job.id, op: job.op, preimage: job.preimage, overwriteBindingInput: job.overwriteBindingInput });
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

  function submit(op: ProofOp, preimage: Uint8Array, keyMaterial: WasmKeyMaterialProvider, overwriteBindingInput?: bigint): Promise<unknown> {
    if (closed) return Promise.reject(new Error('Proof pool is closed'));
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, op, preimage, overwriteBindingInput, keyMaterial, resolve, reject });
      pump();
    });
  }

  return {
    provider(keyMaterial) {
      return {
        check: (preimage) => submit('check', preimage, keyMaterial) as Promise<(bigint | undefined)[]>,
        prove: (preimage, _keyLocation, overwriteBindingInput) =>
          submit('prove', preimage, keyMaterial, overwriteBindingInput) as Promise<Uint8Array>,
      };
    },
    close() {
      closed = true;
      const error = new Error('Proof pool is closed');
      for (const slot of [...slots]) {
        const job = slot.job;
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
