// Separate from the wallet host: synchronous ledger work here cannot block
// balances, signing, or transaction handling in the user's wallet worker.
import {IdbSyncStateStore} from '@shieldedtech/moth-browser';
import {IndexerClient} from '@shieldedtech/moth-wallet/network/indexer-client';
import {optimizeReferenceCandidate} from '@shieldedtech/moth-wallet/sync/reference-candidate';
import {readEventWitness} from '@shieldedtech/moth-wallet/sync/cursor-witness';
import {refreshEmptyRefCache} from '@shieldedtech/moth-wallet/sync/preseed';
import {readLegacyReference, referenceStillValid, type ReferenceSnapshot} from '@shieldedtech/moth-wallet/sync/reference-versions';
import {cursorWitnessKey, emptyRefHeightKey, emptyRefStateKey, EMPTY_REF_WALLET, type SyncStateStore} from '@shieldedtech/moth-wallet/sync/sync-store';
import type {ReferenceJob, ReferenceJobMessage} from './reference-job-types';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<ReferenceJob>) => void;
  postMessage: (message: ReferenceJobMessage) => void;
};

async function contribute(job: Extract<ReferenceJob, {kind: 'contribute'}>): Promise<ReferenceSnapshot | null> {
  if (job.source && !(await referenceStillValid(job.source, job.network.indexerUrl))) return null;
  // Read AFTER capture. An overstated height only makes birthday eligibility stricter.
  const tip = await new IndexerClient(job.network.indexerUrl).getBlock();
  if (!tip?.height) return null;
  let states;
  try {
    states = optimizeReferenceCandidate(job.network.id, {...job.snapshot, height: tip.height});
  } catch {
    // Funds, pending records, unsupported serialization: simply decline the contribution.
    return null;
  }
  const witnesses: ReferenceSnapshot['witnesses'] = {};
  for (const part of ['shielded', 'dust'] as const) {
    const id = Number(JSON.parse(states[part]).offset);
    const witness = await readEventWitness(job.network.indexerUrl, part === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents', id);
    if (!witness) return null;
    witnesses[part] = witness;
  }
  return {...states, network: job.network.id, witnesses};
}

async function refresh(job: Extract<ReferenceJob, {kind: 'refresh'}>): Promise<ReferenceSnapshot | null> {
  const backing = new IdbSyncStateStore();
  const store: SyncStateStore = {
    get: key => backing.get(job.prefix + key),
    put: (key, value) => backing.put(job.prefix + key, value),
    delete: key => backing.delete(job.prefix + key),
  };
  // Each job has a fresh working prefix, never an immutable version or wallet cache.
  if (!(await store.get('initialized'))) {
    if (job.reference) {
      for (const part of ['shielded', 'unshielded', 'dust'] as const) {
        await store.put(emptyRefStateKey(job.network.id, part), job.reference[part]);
      }
      for (const part of ['shielded', 'dust'] as const) {
        const witness = job.reference.witnesses[part];
        if (witness) await store.put(cursorWitnessKey(job.network.id, EMPTY_REF_WALLET, part), JSON.stringify(witness));
      }
      await store.put(emptyRefHeightKey(job.network.id), String(job.reference.height));
    }
    await store.put('initialized', 'true');
  }
  const result = await refreshEmptyRefCache(job.network,
    message => scope.postMessage({kind: 'progress', message}), store,
    progress => scope.postMessage({kind: 'progress', progress}));
  if (!result) return null;
  const snapshot = await readLegacyReference(store, job.network.id);
  // Check that the exported form is ownership-free too, and replace reference identity.
  if (!snapshot) return null;
  return {...snapshot, ...optimizeReferenceCandidate(job.network.id, snapshot)};
}

export async function buildReference(job: ReferenceJob): Promise<ReferenceSnapshot | null> {
  return job.kind === 'contribute' ? contribute(job) : refresh(job);
}
