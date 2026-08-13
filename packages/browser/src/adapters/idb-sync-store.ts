import type { SyncStateStore } from '@shieldedtech/moth-wallet';
import { IndexedDbStorageAdapter } from './idb-storage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * SyncStateStore backed by the shared `moth` IndexedDB (kv store), so wallet
 * sync progress survives extension/service-worker restarts in the browser.
 */
export class IdbSyncStateStore implements SyncStateStore {
  constructor(private readonly adapter: IndexedDbStorageAdapter = new IndexedDbStorageAdapter()) {}

  async get(key: string): Promise<string | null> {
    const data = await this.adapter.read(key);
    return data === null ? null : decoder.decode(data);
  }

  async put(key: string, value: string): Promise<void> {
    await this.adapter.write(key, encoder.encode(value));
  }

  async delete(key: string): Promise<void> {
    await this.adapter.delete(key);
  }
}
