import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardanoConfig } from '../../../src/cardano/config.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** Minimal StorageAdapter stand-in: only `read` is used. */
function storageOf(entries: Record<string, string>) {
  const encoder = new TextEncoder();
  return {
    read: async (key: string) =>
      key in entries ? encoder.encode(entries[key]!) : null,
  };
}

describe('loadCardanoConfig', () => {
  const clearEnv = () => {
    for (const key of [
      'MOTH_CARDANO_NETWORK',
      'MOTH_BLOCKFROST_URL',
      'MOTH_BLOCKFROST_PROJECT_ID',
    ]) {
      delete process.env[key];
    }
  };

  it('falls back to the pairing when nothing is stored', async () => {
    clearEnv();
    const config = await loadCardanoConfig(storageOf({}), 'preprod');
    expect(config.network).toBe('Preprod');
    expect(config.blockfrostProjectId).toBeUndefined();
  });

  it('reads stored config', async () => {
    clearEnv();
    const config = await loadCardanoConfig(
      storageOf({ 'config/blockfrost-project-id': 'stored-id' }),
      'preview',
    );
    expect(config.network).toBe('Preview');
    expect(config.blockfrostProjectId).toBe('stored-id');
  });

  it('ignores a stored cardano-network — the pairing is not configurable', async () => {
    // A left-over value from before the pairing was derived must not resurrect
    // the mismatch it used to allow.
    clearEnv();
    const config = await loadCardanoConfig(
      storageOf({ 'config/cardano-network': 'Mainnet' }),
      'preprod',
    );
    expect(config.network).toBe('Preprod');
  });

  it('lets the environment beat stored config', async () => {
    clearEnv();
    process.env.MOTH_BLOCKFROST_PROJECT_ID = 'env-id';
    try {
      const config = await loadCardanoConfig(
        storageOf({ 'config/blockfrost-project-id': 'stored-id' }),
        'preview',
      );
      expect(config.blockfrostProjectId).toBe('env-id');
    } finally {
      clearEnv();
    }
  });

  it('ignores MOTH_CARDANO_NETWORK for the same reason', async () => {
    clearEnv();
    process.env.MOTH_CARDANO_NETWORK = 'Mainnet';
    try {
      expect((await loadCardanoConfig(storageOf({}), 'preview')).network).toBe('Preview');
    } finally {
      clearEnv();
    }
  });

  it('survives a storage adapter that throws', async () => {
    clearEnv();
    const broken = { read: async () => { throw new Error('no storage'); } };
    await expect(loadCardanoConfig(broken, 'preview')).resolves.toMatchObject({
      network: 'Preview',
    });
  });
});

/**
 * The extension's service worker imports these two modules directly, and
 * nothing whose module graph reaches WASM may enter a Chrome MV3 service
 * worker — registration fails outright. Lucid's Data helpers pull in the
 * Cardano multiplatform library, so `datum.ts` is fine to reach WASM and these
 * two are not.
 */
describe('service-worker-safe subpaths', () => {
  it.each(['cardano/network.ts', 'cardano/config.ts'])('%s does not import Lucid', relPath => {
    const source = readFileSync(resolve(SRC, relPath), 'utf-8');
    expect(source).not.toMatch(/@lucid-evolution/);
  });

  it('the modules that DO need Lucid import it dynamically or as types only', () => {
    // blueprint.ts and session.ts are loaded by surfaces that can afford the
    // WASM, but they still defer it so importing the barrel for a type does
    // not drag it in.
    for (const relPath of ['cardano/blueprint.ts', 'cardano/session.ts']) {
      const source = readFileSync(resolve(SRC, relPath), 'utf-8');
      const staticValueImport = /^import\s+(?!type\b)[^;]*from\s+'@lucid-evolution/m;
      expect(staticValueImport.test(source), `${relPath} statically imports Lucid`).toBe(false);
    }
  });
});
