import ReferenceWorker from './reference-worker?worker';
import type {ReferenceSnapshot} from '@shieldedtech/moth-wallet/sync/reference-versions';
import type {ReferenceJob, ReferenceJobMessage} from './reference-job-types';

interface ActiveJob { cancel: () => void }
const jobs = new Map<string, ActiveJob>();

/** One job per network. No inline fallback: optimization must never block the wallet worker. */
export function runReferenceJob(
  job: ReferenceJob, onProgress?: (message: Extract<ReferenceJobMessage, {kind: 'progress'}>) => void,
): Promise<ReferenceSnapshot | null> {
  if (jobs.has(job.network.id)) return Promise.reject(new Error('Reference work already running'));
  return new Promise((resolve, reject) => {
    const worker = new ReferenceWorker({name: 'moth-reference-builder'});
    let finished = false;
    const finish = (snapshot: ReferenceSnapshot | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      jobs.delete(job.network.id);
      if (error) reject(error); else resolve(snapshot);
    };
    const timer = setTimeout(() => finish(null, new Error('Reference work timed out')), 2 * 60 * 60_000 + 60_000);
    jobs.set(job.network.id, {cancel: () => finish(null, new Error('Reference work cancelled'))});
    worker.onmessage = ({data}: MessageEvent<ReferenceJobMessage>) => {
      if (finished) return;
      if (data.kind === 'progress') onProgress?.(data);
      else if (data.kind === 'complete') finish(data.snapshot);
      else finish(null, new Error('Reference work failed'));
    };
    worker.onerror = () => finish(null, new Error('Reference worker failed'));
    worker.onmessageerror = () => finish(null, new Error('Reference worker response could not be read'));
    try { worker.postMessage(job); } catch { finish(null, new Error('Reference work could not start')); }
  });
}

export function cancelReferenceJob(networkId: string): void { jobs.get(networkId)?.cancel(); }
