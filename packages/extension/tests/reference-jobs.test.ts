import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ReferenceJob} from '../lib/offscreen/reference-job-types';

const workers = vi.hoisted(() => [] as any[]);
vi.mock('../lib/offscreen/reference-worker?worker', () => ({default: class {
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage: any;
  onerror: any;
  constructor() { workers.push(this); }
}}));
import {cancelReferenceJob, runReferenceJob} from '../lib/offscreen/reference-jobs';

const job = {kind: 'contribute', network: {id: 'preview'}, snapshot: {shielded: 'captured', unshielded: 'captured', dust: 'captured'}, source: null} as ReferenceJob;
afterEach(() => {cancelReferenceJob('preview'); workers.length = 0;});

describe('isolated reference work', () => {
  it('returns immediately, forwards progress and terminates after completion', async () => {
    const progress = vi.fn();
    const pending = runReferenceJob(job, progress);
    const worker = workers[0];
    expect(worker.postMessage).toHaveBeenCalledWith(job);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage({data: {kind: 'progress', message: 'working'}});
    expect(progress).toHaveBeenCalledWith({kind: 'progress', message: 'working'});
    worker.onmessage({data: {kind: 'complete', snapshot: null}});
    expect(await pending).toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate work and ignores late messages after a reset cancels it', async () => {
    const progress = vi.fn();
    const pending = runReferenceJob(job, progress);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await expect(runReferenceJob(job)).rejects.toThrow('already running');
    cancelReferenceJob('preview');
    await rejected;
    workers[0].onmessage({data: {kind: 'progress', message: 'late'}});
    workers[0].onmessage({data: {kind: 'complete', snapshot: {height: 999}}});
    expect(progress).not.toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    const retry = runReferenceJob(job);
    workers[1].onmessage({data: {kind: 'complete', snapshot: null}});
    await retry;
  });

  it('cleans up a failed worker and allows a later attempt', async () => {
    const pending = runReferenceJob(job);
    const rejected = expect(pending).rejects.toThrow('worker failed');
    workers[0].onerror();
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = runReferenceJob(job);
    workers[1].onmessage({data: {kind: 'complete', snapshot: null}});
    await retry;
  });
});
