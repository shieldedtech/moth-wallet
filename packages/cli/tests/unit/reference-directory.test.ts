import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {afterEach, describe, expect, it} from 'vitest';
import {emptyRefHeightKey, importReference, type SyncStateStore} from '@shieldedtech/moth-wallet';
import {cursorWitnessKey, EMPTY_REF_WALLET} from '@shieldedtech/moth-wallet/sync/sync-store';
import {readReferenceDirectory, ReferenceDirectoryError} from '../../src/preseed/reference-directory.js';

class MemoryStore implements SyncStateStore {
  readonly entries = new Map<string, string>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.entries.set(key, value);
  }
  async delete(key: string) {
    this.entries.delete(key);
  }
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moth-reference-dir-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

function writeParts(dir: string): void {
  for (const part of ['shielded', 'unshielded', 'dust']) {
    writeFileSync(join(dir, `${part}.dat.gz`), gzipSync(Buffer.from(`{"${part}":true}`)));
  }
}

describe('readReferenceDirectory', () => {
  it('loads the witness files a `preseed export` directory carries', async () => {
    const dir = tempDir();
    writeParts(dir);
    const witness = '{"stream":"dustLedgerEvents","id":1449980,"digest":"ffdc476b89fca076"}';
    writeFileSync(join(dir, 'witness-dust.json'), witness);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({network: 'preprod', height: 100, parts: {}, witnesses: ['dust']}),
    );

    const bundle = readReferenceDirectory(dir);
    expect([...bundle.files.keys()].sort()).toEqual(
      ['dust.dat.gz', 'shielded.dat.gz', 'unshielded.dat.gz', 'witness-dust.json'].sort(),
    );

    const store = new MemoryStore();
    await importReference(store, 'preprod', bundle);
    expect(store.entries.get(cursorWitnessKey('preprod', EMPTY_REF_WALLET, 'dust'))).toBe(witness);
  });

  it('imports a committed extension bundle with its witnesses intact', async () => {
    // The directory `preseed import`'s own help text points at. Its witnesses live
    // inline in manifest.json, and before this fix they were silently dropped.
    const dir = resolve(__dirname, '../../../extension/public/preseed/preview');
    const bundle = readReferenceDirectory(dir);
    const manifest = bundle.manifest as {height: number; witnesses: Record<string, unknown>};

    const store = new MemoryStore();
    await importReference(store, 'preview', bundle);

    expect(store.entries.get(emptyRefHeightKey('preview'))).toBe(String(manifest.height));
    for (const part of ['shielded', 'dust'] as const) {
      expect(JSON.parse(store.entries.get(cursorWitnessKey('preview', EMPTY_REF_WALLET, part))!)).toEqual(
        manifest.witnesses[part],
      );
    }
  });

  it('explains a directory with no manifest', () => {
    const dir = tempDir();
    expect(() => readReferenceDirectory(dir)).toThrow(ReferenceDirectoryError);
    expect(() => readReferenceDirectory(dir)).toThrow(/No manifest\.json/);
  });

  it('explains a manifest that is not JSON', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'manifest.json'), '<html>dev server fallback</html>');
    expect(() => readReferenceDirectory(dir)).toThrow(/not readable JSON/);
  });
});
