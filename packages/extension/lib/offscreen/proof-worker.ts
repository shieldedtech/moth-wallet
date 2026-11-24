// One proof worker: a single zkir WASM proof at a time on its own thread, so the
// pool (proof-pool.ts) can run a transaction's proofs in parallel. It holds no key
// material; each job asks the pool, which keeps the one cached copy.

import type { ProvingKeyMaterial } from '@midnightntwrk/zkir-v2';
import type { ZkirVersion } from '@shieldedtech/moth-browser';
import { serializeHostError, deserializeHostError } from './worker-rpc';
import { isKeyReply, type KeyQuery, type PoolToWorker, type ProofJobRequest, type WorkerToPool } from './proof-rpc';

interface WorkerScope {
  onmessage: ((event: MessageEvent<PoolToWorker>) => void) | null;
  postMessage(message: WorkerToPool): void;
}
const workerScope = self as unknown as WorkerScope;

interface PendingKey {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
const pendingKeys = new Map<number, PendingKey>();
let nextReqId = 1;

// zkir calls lookupKey/getParams while proving; each becomes a round trip to
// the pool, correlated by reqId.
function remoteKeyMaterial(jobId: number) {
  const ask = (query: KeyQuery): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const reqId = nextReqId++;
      pendingKeys.set(reqId, { resolve, reject });
      workerScope.postMessage({ id: jobId, reqId, ...query });
    });
  return {
    lookupKey: (keyLocation: string) =>
      ask({ req: 'lookupKey', keyLocation }) as Promise<ProvingKeyMaterial | undefined>,
    getParams: (k: number) => ask({ req: 'getParams', k }) as Promise<Uint8Array>,
  };
}

type Zkir = Pick<typeof import('@midnightntwrk/zkir-v2'), 'prove' | 'check'>;
// Both zkir packages are imported on first use, never at module load. Each
// instantiates its WASM with a top-level await, and a module worker starts
// delivering messages before that await settles: with a static import the
// pool's first job arrived before `onmessage` below was set and was dropped, so
// every local proof waited forever without asking for a key. Loading lazily
// keeps this module free of top-level awaits, so the handler is in place before
// the first message. zkir-v3 is loaded only by a worker handed a ZKIR v3
// circuit; the wallet's own circuits are ZKIR v2.
let zkirV2: Promise<Zkir> | undefined;
let zkirV3: Promise<Zkir> | undefined;
const zkirFor = (version: ZkirVersion): Promise<Zkir> =>
  version === 'v3'
    ? (zkirV3 ??= import('@midnightntwrk/zkir-v3'))
    : (zkirV2 ??= import('@midnightntwrk/zkir-v2'));

async function run(job: ProofJobRequest): Promise<void> {
  try {
    const keyMaterial = remoteKeyMaterial(job.id);
    const zkir = await zkirFor(job.zkir);
    const result =
      job.op === 'prove'
        ? await zkir.prove(job.preimage, keyMaterial, job.overwriteBindingInput)
        : await zkir.check(job.preimage, keyMaterial);
    workerScope.postMessage({ id: job.id, ok: true, result });
  } catch (err) {
    workerScope.postMessage({ id: job.id, ok: false, error: serializeHostError(err) });
  }
}

workerScope.onmessage = (event: MessageEvent<PoolToWorker>) => {
  const message = event.data;
  if (isKeyReply(message)) {
    const entry = pendingKeys.get(message.reqId);
    if (!entry) return;
    pendingKeys.delete(message.reqId);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(deserializeHostError(message.error));
    return;
  }
  void run(message);
};
