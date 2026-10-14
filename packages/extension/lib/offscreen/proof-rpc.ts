// Wire types for the wallet-worker ⇄ proof-worker RPC: a job flows pool → worker,
// the worker asks the pool for key material while it runs, then posts its result.
// No runtime imports: this module is evaluated inside the proof workers.

export type ProofOp = 'prove' | 'check';

/** pool → worker: run one proof (or preimage check). */
export interface ProofJobRequest {
  id: number;
  op: ProofOp;
  preimage: Uint8Array;
  overwriteBindingInput?: bigint;
}

/** What a running job needs looked up (the pool holds the key material). */
export type KeyQuery = { req: 'lookupKey'; keyLocation: string } | { req: 'getParams'; k: number };

/** worker → pool: a KeyQuery, correlated to its job and to its reply. */
export type KeyRequest = KeyQuery & { id: number; reqId: number };

/** pool → worker: the answer to a KeyRequest. */
export type KeyReply =
  | { id: number; reqId: number; ok: true; result: unknown }
  | { id: number; reqId: number; ok: false; error: unknown };

/** worker → pool: the job's outcome. */
export type ProofJobResult = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: unknown };

export type PoolToWorker = ProofJobRequest | KeyReply;
export type WorkerToPool = KeyRequest | ProofJobResult;

export function isKeyRequest(message: WorkerToPool): message is KeyRequest {
  return 'req' in message;
}

export function isKeyReply(message: PoolToWorker): message is KeyReply {
  return 'reqId' in message;
}
