import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installBundledReference } from '../lib/offscreen/bundled-preseed';
import {REFERENCE_CATALOG_KEY, selectReferenceVersion, referenceVersionsStatus, registerReferenceWallet, resetReferenceVersions} from '@shieldedtech/moth-wallet/sync/reference-versions';

const NETWORK = 'preprod';
const HEIGHT_KEY = `empty-ref/${NETWORK}/height.txt`;
const stateKey = (part: string) => `sync/${NETWORK}/__empty_ref__/${part}.dat`;

/** Records atomic catalog publication alongside unchanged legacy keys. */
function recordingStore() {
  const entries = new Map<string, string>();
  const writes: string[] = [];
  return {
    entries,
    writes,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      writes.push(key);
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Serve the package assets a real export would produce. `missing` omits one,
 *  to exercise the all-or-nothing rule. */
async function serveAssets(options: { height?: number; missing?: string; witnesses?: boolean } = {}) {
  const height = options.height ?? 1985914;
  const assets = new Map<string, BodyInit>();
  // Witnesses are required: a bundle whose cursors cannot be checked against the
  // serving indexer is refused. `witnesses: false` exercises that refusal.
  const witnesses =
    options.witnesses === false
      ? undefined
      : {
          shielded: { stream: 'zswapLedgerEvents', id: 1_431_228, digest: 'aaaaaaaaaaaaaaaa' },
          dust: { stream: 'dustLedgerEvents', id: 1_431_375, digest: 'bbbbbbbbbbbbbbbb' },
        };
  assets.set('manifest.json', JSON.stringify({ network: NETWORK, height, parts: {}, witnesses }));
  for (const part of ['shielded', 'unshielded', 'dust']) {
    if (part === options.missing) continue;
    assets.set(`${part}.dat.gz`, await gzip(JSON.stringify({offset: part === 'dust' ? '1431375' : '1431228', state: part})));
  }
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const file = String(input).split('/').pop()!;
    const body = assets.get(file);
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  });
}

beforeEach(() => {
  // The loader resolves package-relative URLs against the worker's own origin.
  vi.stubGlobal('self', { location: { href: 'chrome-extension://abc/offscreen.html' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installBundledReference', () => {
  it('publishes the complete bundle and its witnesses in one catalog write', async () => {
    await serveAssets();
    const store = recordingStore();
    await expect(installBundledReference(NETWORK, store)).resolves.toBe(true);
    const reference = await selectReferenceVersion(store, {id: NETWORK, indexerUrl: 'unused'}, undefined, async () => true);
    expect(reference?.height).toBe(1985914);
    expect(JSON.parse(reference!.dust).offset).toBe('1431375');
    expect(reference?.witnesses.dust).toEqual({stream: 'dustLedgerEvents', id: 1431375, digest: 'bbbbbbbbbbbbbbbb'});
    expect(store.entries.has(HEIGHT_KEY)).toBe(false);
  });

  it('keeps an existing wallet pinned across an upgrade while new wallets get the new bundle', async () => {
    const store = recordingStore();
    await serveAssets({height: 100});
    await installBundledReference(NETWORK, store);
    await serveAssets({height: 200});
    await installBundledReference(NETWORK, store, [{name: 'existing', birthday: 150}]);
    const config = {id: NETWORK, indexerUrl: 'unused'};
    expect((await selectReferenceVersion(store, config, {name: 'existing', birthday: 150}, async () => true))?.height).toBe(100);
    expect((await selectReferenceVersion(store, config, {name: 'new', birthday: 250}, async () => true))?.height).toBe(200);
  });

  it('migrates the legacy reference before installing a newer bundle', async () => {
    const store = recordingStore();
    await store.put(HEIGHT_KEY, '100');
    for (const part of ['shielded', 'unshielded', 'dust']) await store.put(stateKey(part), JSON.stringify({offset: '1'}));
    await serveAssets({height: 200});
    await installBundledReference(NETWORK, store, [{name: 'existing', birthday: 150}]);
    const reference = await selectReferenceVersion(store, {id: NETWORK, indexerUrl: 'unused'}, {name: 'existing', birthday: 150}, async () => true);
    expect(reference?.height).toBe(100);
    expect(await store.get(HEIGHT_KEY)).toBe('100');
  });

  it('does not duplicate or downgrade an installed bundle', async () => {
    const store = recordingStore();
    await serveAssets({height: 200});
    await installBundledReference(NETWORK, store);
    store.writes.length = 0;
    expect(await installBundledReference(NETWORK, store)).toBe(false);
    await serveAssets({height: 100});
    expect(await installBundledReference(NETWORK, store)).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('leaves the previous version usable if the atomic publication fails', async () => {
    const store = recordingStore();
    await serveAssets({height: 100});
    await installBundledReference(NETWORK, store, []);
    const before = await store.get(REFERENCE_CATALOG_KEY);
    await serveAssets({height: 200});
    const failing = {...store, put: async () => {throw new Error('quota exceeded');}};
    expect(await installBundledReference(NETWORK, failing)).toBe(false);
    expect(await store.get(REFERENCE_CATALOG_KEY)).toBe(before);
  });

  it('does not publish half a bundle or one without evidence', async () => {
    for (const options of [{missing: 'dust'}, {witnesses: false}, {height: 0}]) {
      await serveAssets(options);
      const store = recordingStore();
      expect(await installBundledReference(NETWORK, store)).toBe(false);
      expect((await referenceVersionsStatus(store, NETWORK)).ready).toBe(false);
    }
  });

  it('refuses assets for another network', async () => {
    await serveAssets();
    const store = recordingStore();
    expect(await installBundledReference('preview', store)).toBe(false);
    expect((await referenceVersionsStatus(store, 'preview')).ready).toBe(false);
  });

  it('reinstalls the bundle after an explicit reset, without old assignments', async () => {
    const store = recordingStore();
    await serveAssets({height: 100});
    await installBundledReference(NETWORK, store, []);
    await registerReferenceWallet(store, NETWORK, {name: 'old', birthday: 150});
    await resetReferenceVersions(store, NETWORK);
    await serveAssets({height: 200});
    expect(await installBundledReference(NETWORK, store)).toBe(true);
    const config = {id: NETWORK, indexerUrl: 'unused'};
    expect(await selectReferenceVersion(store, config, {name: 'old', birthday: 150}, async () => true)).toBeNull();
    expect((await selectReferenceVersion(store, config, {name: 'new', birthday: 250}, async () => true))?.height).toBe(200);
  });

  it('never lets an unavailable asset stop wallet startup', async () => {
    for (const response of [async () => new Response(null, {status: 404}), async () => new Response('not JSON'), async () => {throw new Error('unavailable');}]) {
      vi.stubGlobal('fetch', response);
      await expect(installBundledReference(NETWORK, recordingStore())).resolves.toBe(false);
    }
  });
});
