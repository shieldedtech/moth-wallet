// One proof worker: a single zkir WASM proof at a time on its own thread, so the
// pool (proof-pool.ts) can run a transaction's proofs in parallel. It holds no key
// material; each job asks the pool, which keeps the one cached copy.

import { prove, check, type ProvingKeyMaterial } from '@midnight-ntwrk/zkir-v2';
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

async function run(job: ProofJobRequest): Promise<void> {
  try {
    const keyMaterial = remoteKeyMaterial(job.id);
    const result =
      job.op === 'prove'
        ? await prove(job.preimage, keyMaterial, job.overwriteBindingInput)
        : await check(job.preimage, keyMaterial);
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
