import type { StorageAdapter } from '@shieldedtech/moth-wallet';

const DB_NAME = 'moth';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = fn(store);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        transaction.oncomplete = () => db.close();
      }),
  );
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  async read(key: string): Promise<Uint8Array | null> {
    const result = await tx('readonly', store => store.get(key));
    if (result instanceof Uint8Array) return result;
    if (result instanceof ArrayBuffer) return new Uint8Array(result);
    return null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    await tx('readwrite', store => store.put(data, key));
  }

  async delete(key: string): Promise<void> {
    await tx('readwrite', store => store.delete(key));
  }

  async list(prefix: string): Promise<string[]> {
    const db = await openDb();
    return new Promise<string[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const keys = (request.result as string[]).filter(k => k.startsWith(prefix));
        resolve(keys);
      };
      transaction.oncomplete = () => db.close();
    });
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.read(key);
    return result !== null;
  }
}
