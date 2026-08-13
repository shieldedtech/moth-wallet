import { readFile, writeFile, unlink, readdir, stat, mkdir, chmod, open, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { StorageAdapter } from './adapter.js';
import { safePath } from './safe-path.js';

const DEFAULT_DIR = join(homedir(), '.moth');
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 30_000; // Consider lock stale after 30s

export class FilesystemStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir = DEFAULT_DIR) {
    this.baseDir = baseDir;
  }

  private resolvePath(key: string): string {
    return safePath(this.baseDir, key);
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      const data = await readFile(this.resolvePath(key));
      return new Uint8Array(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });

    // Advisory file locking for concurrent access (T087)
    const lockPath = path + LOCK_SUFFIX;
    await this.acquireLock(lockPath);
    try {
      // Atomic write: stage into a temp file in the same directory, then
      // rename over the target. rename(2) is atomic on POSIX, so a crash or
      // full disk mid-write leaves either the old file intact or the new one
      // complete — never a half-written keystore that can't be opened.
      const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
      try {
        await writeFile(tmpPath, data, { mode: 0o600 });
        // Ensure owner-only perms (FR-005) before the file becomes visible.
        await chmod(tmpPath, 0o600);
        await rename(tmpPath, path);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
    } finally {
      await this.releaseLock(lockPath);
    }
  }

  private async acquireLock(lockPath: string): Promise<void> {
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      try {
        // O_CREAT | O_EXCL — fails if file exists (atomic lock)
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Check if lock is stale
          try {
            const lockStat = await stat(lockPath);
            if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
              await unlink(lockPath);
              continue; // Retry after removing stale lock
            }
          } catch {
            continue; // Lock disappeared, retry
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Could not acquire lock on ${lockPath} — another process may be using this wallet`);
  }

  private async releaseLock(lockPath: string): Promise<void> {
    try {
      await unlink(lockPath);
    } catch {
      // Lock already released — not an error
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Use safePath to prevent path traversal outside baseDir (CWE-22)
    const dir = safePath(this.baseDir, prefix);
    try {
      const entries = await readdir(dir);
      return entries.map(e => `${prefix}/${e}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }
}
