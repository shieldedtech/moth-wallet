import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { hasBundledReference, installBundledReference } from '../lib/offscreen/bundled-preseed';

const NETWORK = 'preprod';
const HEIGHT_KEY = `empty-ref/${NETWORK}/height.txt`;
const stateKey = (part: string) => `sync/${NETWORK}/__empty_ref__/${part}.dat`;
const PRESEED_ROOT = new URL('../public/preseed/', import.meta.url);

/** Records the ORDER of writes: the height must land last, so an interrupted
 *  install leaves state that loadUsableRefStates ignores rather than trusts. */
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
    assets.set(`${part}.dat.gz`, await gzip(`${part}-state-blob`));
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
  it('accepts every reference shipped in the extension package', async () => {
    const networks = readdirSync(PRESEED_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    vi.stubGlobal('fetch', async (input: string | URL) => {
      const network = new URL(String(input)).pathname.split('/').at(-2);
      if (!network || !networks.includes(network)) return new Response(null, { status: 404 });
      const manifest = readFileSync(new URL(`${network}/manifest.json`, PRESEED_ROOT), 'utf8');
      return new Response(manifest, { status: 200 });
    });

    for (const network of networks) {
      await expect(hasBundledReference(network), network).resolves.toBe(true);
    }
  });

  it('writes all three states and the height', async () => {
    await serveAssets();
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(true);

    expect(store.entries.get(stateKey('shielded'))).toBe('shielded-state-blob');
    expect(store.entries.get(stateKey('unshielded'))).toBe('unshielded-state-blob');
    expect(store.entries.get(stateKey('dust'))).toBe('dust-state-blob');
    expect(store.entries.get(HEIGHT_KEY)).toBe('1985914');
  });

  it('writes the height LAST, so an interrupted install is ignored not trusted', async () => {
    await serveAssets();
    const store = recordingStore();
    await installBundledReference(NETWORK, store);

    // A reference with no recorded height is unusable by construction
    // (loadUsableRefStates), which is what makes a partial write safe.
    expect(store.writes[store.writes.length - 1]).toBe(HEIGHT_KEY);
    expect(store.writes.indexOf(HEIGHT_KEY)).toBe(store.writes.length - 1);
  });

  it('never overwrites a reference already in the store', async () => {
    await serveAssets({ height: 1985914 });
    const store = recordingStore();
    // A locally built reference is at least as fresh as anything shipped.
    await store.put(HEIGHT_KEY, '2045150');
    store.writes.length = 0;

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.entries.get(HEIGHT_KEY)).toBe('2045150');
  });

  it('stores a witness per cursor-bearing part, so the reference can be verified later', async () => {
    await serveAssets();
    const store = recordingStore();

    await installBundledReference(NETWORK, store);

    expect(JSON.parse(store.entries.get(`witness/${NETWORK}/__empty_ref__/dust.json`)!)).toEqual({
      stream: 'dustLedgerEvents',
      id: 1_431_375,
      digest: 'bbbbbbbbbbbbbbbb',
    });
    // Before the height, which is what marks the reference usable — a reference
    // that reads as usable without its witnesses is one that skips verification.
    expect(store.writes.indexOf(`witness/${NETWORK}/__empty_ref__/dust.json`)).toBeLessThan(
      store.writes.indexOf(HEIGHT_KEY),
    );
  });

  // #40: the shipped preprod bundle had no witnesses, so nothing could tell that
  // its cursors had stopped meaning what they meant. Refused rather than trusted:
  // unlike a local reference, this is an artefact we control and can re-cut, so
  // the cost of refusing is one slower first sync.
  it('refuses a bundle with no witnesses rather than installing an unverifiable one', async () => {
    await serveAssets({ witnesses: false });
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('writes nothing when the network ships no reference', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    const store = recordingStore();

    await expect(installBundledReference('devnet', store)).resolves.toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('writes nothing when a part is missing — all three or none', async () => {
    await serveAssets({ missing: 'dust' });
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
    // Dust is the expensive part; a reference without it is worthless, and
    // writing the cheap two would waste quota for nothing.
    expect(store.writes).toEqual([]);
  });

  it('rejects a manifest with no usable height', async () => {
    await serveAssets({ height: 0 });
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('never throws when the asset is corrupt — a slow sync beats a dead wallet', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      if (String(input).endsWith('manifest.json')) return new Response('not json at all', { status: 200 });
      return new Response(null, { status: 404 });
    });
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('never throws when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network gone');
    });
    const store = recordingStore();

    await expect(installBundledReference(NETWORK, store)).resolves.toBe(false);
  });
});
