import {afterEach, describe, expect, it, vi} from 'vitest';
import {IndexedDbStorageAdapter} from '../../src/adapters/idb-storage.js';

function database() {
  const request = {result: undefined, error: null, onsuccess: () => {}};
  const transaction = {objectStore: () => ({put: () => request}), oncomplete: () => {}, onabort: () => {}, error: null as Error | null};
  const db = {transaction: () => transaction, close: vi.fn()};
  const opening = {result: db, onsuccess: () => {}};
  vi.stubGlobal('indexedDB', {open: () => opening});
  return {request, transaction, db, opening};
}
afterEach(() => vi.unstubAllGlobals());
describe('IndexedDB writes wait for commit', () => {
  it('does not publish success while only the request has succeeded', async () => {
    const fake = database();
    let done = false;
    const write = new IndexedDbStorageAdapter().write('reference', new Uint8Array()).then(() => {done = true;});
    fake.opening.onsuccess();
    await Promise.resolve();
    fake.request.onsuccess();
    await Promise.resolve();
    expect(done).toBe(false);
    fake.transaction.oncomplete();
    await write;
    expect(done).toBe(true);
    expect(fake.db.close).toHaveBeenCalledOnce();
  });
  it('reports an abort even after the request succeeded', async () => {
    const fake = database();
    const write = new IndexedDbStorageAdapter().write('reference', new Uint8Array());
    const rejected = expect(write).rejects.toThrow('quota');
    fake.opening.onsuccess();
    await Promise.resolve();
    fake.request.onsuccess();
    fake.transaction.error = new Error('quota');
    fake.transaction.onabort();
    await rejected;
    expect(fake.db.close).toHaveBeenCalledOnce();
  });
});
