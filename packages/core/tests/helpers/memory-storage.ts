import type { StorageAdapter } from '../../src/storage/adapter.js';

/**
 * In-memory StorageAdapter for tests that need wallet persistence without
 * touching a filesystem or IndexedDB. Implementing the real interface rather
 * than mocking it means a change to StorageAdapter breaks compilation here
 * instead of silently leaving tests asserting against a stale shape.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, Uint8Array>();

  async read(key: string): Promise<Uint8Array | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.values.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async exists(key: string): Promise<boolean> {
    return this.values.has(key);
  }
}
