import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  exportReference,
  importReference,
  ReferenceImportError,
  type PortableReference,
} from '../../../src/sync/preseed-portable.js';
import {
  cursorWitnessKey,
  emptyRefHeightKey,
  emptyRefStateKey,
  emptyRefMnemonicKey,
  EMPTY_REF_WALLET,
  type SyncStateStore,
} from '../../../src/sync/sync-store.js';

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

/** A store holding a complete, usable reference for `network` at `height`. */
function storeWithReference(network: string, height: number): MemoryStore {
  const s = new MemoryStore();
  s.entries.set(emptyRefHeightKey(network), String(height));
  s.entries.set(emptyRefStateKey(network, 'shielded'), '{"shielded":true}');
  s.entries.set(emptyRefStateKey(network, 'unshielded'), '{"unshielded":true}');
  s.entries.set(emptyRefStateKey(network, 'dust'), '{"dust":true}');
  return s;
}

function bundleFor(network: string, height: number): PortableReference {
  const files = new Map<string, Uint8Array>();
  for (const [part, body] of [
    ['shielded', '{"shielded":true}'],
    ['unshielded', '{"unshielded":true}'],
    ['dust', '{"dust":true}'],
  ] as const) {
    files.set(`${part}.dat.gz`, new Uint8Array(gzipSync(Buffer.from(body))));
  }
  return { manifest: { network, height, parts: {} }, files };
}

describe('exportReference', () => {
  it('never exports the reference wallet mnemonic', async () => {
    // The one secret in the arrangement. A published reference is meant to be
    // safe to hand to strangers; the mnemonic controls the wallet it came from.
    const store = storeWithReference('preprod', 100);
    store.entries.set(emptyRefMnemonicKey('preprod'), 'abandon abandon abandon');

    const bundle = (await exportReference(store, 'preprod'))!;
    const serialised = JSON.stringify(bundle.manifest) + [...bundle.files.keys()].join(',');
    expect(serialised).not.toContain('abandon');
    expect([...bundle.files.keys()]).toEqual(['shielded.dat.gz', 'unshielded.dat.gz', 'dust.dat.gz']);
  });

  it('refuses to export when there is nothing usable', async () => {
    // An empty bundle would import as a valid-looking reference at height 0 and
    // seed wallets from genesis while claiming to have saved them the walk.
    expect(await exportReference(new MemoryStore(), 'preprod')).toBeNull();

    const noHeight = storeWithReference('preprod', 100);
    noHeight.entries.delete(emptyRefHeightKey('preprod'));
    expect(await exportReference(noHeight, 'preprod')).toBeNull();

    const zeroHeight = storeWithReference('preprod', 0);
    expect(await exportReference(zeroHeight, 'preprod')).toBeNull();
  });

  it('refuses to export without dust state, which is the whole point', async () => {
    const store = storeWithReference('preprod', 100);
    store.entries.delete(emptyRefStateKey('preprod', 'dust'));
    expect(await exportReference(store, 'preprod')).toBeNull();
  });

  it('refuses to export a partial reference, whichever part is missing', async () => {
    // Export previously skipped a missing part and returned a bundle of what it
    // had, checking only dust. That bundle imports cleanly over someone else's
    // complete reference and mixes heights, so the hole was on this side too.
    for (const part of ['shielded', 'unshielded', 'dust'] as const) {
      const store = storeWithReference('preprod', 100);
      store.entries.delete(emptyRefStateKey('preprod', part));
      await expect(exportReference(store, 'preprod')).resolves.toBeNull();
    }
  });

  it('reports both raw and compressed sizes per part', async () => {
    const bundle = (await exportReference(storeWithReference('preprod', 100), 'preprod'))!;
    expect(bundle.manifest).toMatchObject({ network: 'preprod', height: 100 });
    expect(bundle.manifest.parts.dust!.bytes).toBeGreaterThan(0);
    expect(bundle.manifest.parts.dust!.gzipBytes).toBeGreaterThan(0);
  });
});

describe('importReference refuses rather than guesses', () => {
  it('rejects a bundle built for another network', async () => {
    // Seeding from the wrong chain is silent afterwards: the wallet starts at a
    // height that means nothing on the network it is actually on.
    const store = new MemoryStore();
    await expect(importReference(store, 'preview', bundleFor('preprod', 100))).rejects.toBeInstanceOf(
      ReferenceImportError,
    );
    expect(store.entries.size).toBe(0);
  });

  it('rejects a downgrade unless forced', async () => {
    const store = storeWithReference('preprod', 500);
    await expect(importReference(store, 'preprod', bundleFor('preprod', 100))).rejects.toThrow(/backwards/);
    expect(store.entries.get(emptyRefHeightKey('preprod'))).toBe('500');

    const forced = await importReference(store, 'preprod', bundleFor('preprod', 100), { force: true });
    expect(forced).toEqual({ height: 100, replacedHeight: 500 });
    expect(store.entries.get(emptyRefHeightKey('preprod'))).toBe('100');
  });

  it('accepts the same height, so re-importing a known-good bundle works', async () => {
    const store = storeWithReference('preprod', 500);
    await expect(importReference(store, 'preprod', bundleFor('preprod', 500))).resolves.toMatchObject({
      height: 500,
    });
  });

  it('rejects a bundle with no dust state', async () => {
    const bundle = bundleFor('preprod', 100);
    bundle.files.delete('dust.dat.gz');
    await expect(importReference(new MemoryStore(), 'preprod', bundle)).rejects.toThrow(/dust/);
  });

  it('rejects an unusable height', async () => {
    await expect(importReference(new MemoryStore(), 'preprod', bundleFor('preprod', 0))).rejects.toThrow(
      /height/,
    );
  });
});

describe('importReference writes atomically enough', () => {
  it('writes nothing when a later part is corrupt', async () => {
    // Regression: parts were unpacked as encountered, so a corrupt dust blob —
    // the last and largest — left new shielded/unshielded state beside the old
    // dust state. A mixture that never existed on chain, with a height key that
    // still looked consistent.
    const store = storeWithReference('preprod', 500);
    const bundle = bundleFor('preprod', 900);
    bundle.files.set('dust.dat.gz', new Uint8Array(Buffer.from('not gzip at all')));

    await expect(importReference(store, 'preprod', bundle)).rejects.toThrow(/not valid gzip/);
    expect(store.entries.get(emptyRefStateKey('preprod', 'shielded'))).toBe('{"shielded":true}');
    expect(store.entries.get(emptyRefHeightKey('preprod'))).toBe('500');
  });

  // Joe's finding on #11: the same mixture the gzip case guards against was
  // reachable one step over, through a MISSING part rather than a corrupt one.
  // Only dust was required, so a bundle without shielded imported the other two
  // over an existing reference and moved the height key — leaving shielded at the
  // old height while `loadUsableRefStates` reported the pair as ready, and the
  // inflated height then feeding `emptyRef.height <= birthday`.
  it('writes nothing when a part is missing, not just when one is corrupt', async () => {
    const store = storeWithReference('preprod', 5_123_456);
    const before = new Map(store.entries);

    const partial = bundleFor('preprod', 9_999_999);
    partial.files.delete('shielded.dat.gz');

    await expect(importReference(store, 'preprod', partial)).rejects.toThrow(ReferenceImportError);
    // The height key in particular: advertising 9,999,999 over height-5,123,456
    // shielded state is what would seed wallets born between the two.
    expect(store.entries).toEqual(before);
  });

  it('names every missing part, so the bundle can be fixed in one go', async () => {
    const store = storeWithReference('preprod', 100);
    const partial = bundleFor('preprod', 200);
    partial.files.delete('shielded.dat.gz');
    partial.files.delete('unshielded.dat.gz');

    await expect(importReference(store, 'preprod', partial)).rejects.toThrow(
      /shielded\.dat\.gz, unshielded\.dat\.gz/,
    );
  });

  it('writes the height only after the state it describes', async () => {
    // The height key is what marks a reference usable. Written first, a process
    // killed midway would advertise a reference that was still being unpacked.
    const order: string[] = [];
    const store = new MemoryStore();
    const spy: SyncStateStore = {
      get: (k) => store.get(k),
      put: async (k, v) => {
        order.push(k);
        await store.put(k, v);
      },
      delete: (k) => store.delete(k),
    };
    await importReference(spy, 'preprod', bundleFor('preprod', 100));
    expect(order[order.length - 1]).toBe(emptyRefHeightKey('preprod'));
  });
});

describe('round trip', () => {
  it('exports and re-imports to an identical store', async () => {
    const source = storeWithReference('preprod', 4242);
    const bundle = (await exportReference(source, 'preprod'))!;

    const target = new MemoryStore();
    const result = await importReference(target, 'preprod', bundle);

    expect(result).toEqual({ height: 4242, replacedHeight: null });
    for (const part of ['shielded', 'unshielded', 'dust'] as const) {
      expect(target.entries.get(emptyRefStateKey('preprod', part))).toBe(
        source.entries.get(emptyRefStateKey('preprod', part)),
      );
    }
    expect(target.entries.get(emptyRefHeightKey('preprod'))).toBe('4242');
  });
});

// A reference's cursors are indexer-assigned event numbers, and a witness is the
// evidence that a cursor still names the event it named when the reference was
// built. That evidence has to be taken where the reference was BUILT, so a bundle
// must carry it — and a bundle is exactly where it matters, since crossing
// machines is how a reference meets a differently-numbered indexer.
//
// The verification treats a MISSING witness as "allow, with a warning", so that
// an upgrading wallet is not punished. That leniency makes a stale witness far
// worse than none: it passes the check on behalf of state it was never taken
// from, and the sync then resumes at the wrong event with a quietly wrong balance.

describe('cursor witnesses travel with a bundle', () => {
  const NET = 'preprod';
  const WITNESS_SHIELDED = '{"stream":"shielded","id":1431375,"hash":"aa"}';
  const WITNESS_DUST = '{"stream":"dust","id":1449958,"hash":"bb"}';

  function withWitnesses(store: MemoryStore): MemoryStore {
    store.entries.set(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'shielded'), WITNESS_SHIELDED);
    store.entries.set(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'dust'), WITNESS_DUST);
    return store;
  }

  it('exports the witnesses it has, and names them in the manifest', async () => {
    const bundle = await exportReference(withWitnesses(storeWithReference(NET, 2_203_416)), NET);

    expect(bundle).not.toBeNull();
    expect(bundle!.manifest.witnesses).toEqual(['shielded', 'dust']);
    expect(new TextDecoder().decode(bundle!.files.get('witness-shielded.json')!)).toBe(WITNESS_SHIELDED);
    expect(new TextDecoder().decode(bundle!.files.get('witness-dust.json')!)).toBe(WITNESS_DUST);
  });

  it('omits the manifest key entirely when there is nothing to witness', async () => {
    const bundle = await exportReference(storeWithReference(NET, 2_203_416), NET);

    expect(bundle!.manifest.witnesses).toBeUndefined();
    expect(bundle!.files.has('witness-shielded.json')).toBe(false);
  });

  it('round-trips the witnesses onto the importing machine', async () => {
    const source = await exportReference(withWitnesses(storeWithReference(NET, 2_203_416)), NET);
    const target = new MemoryStore();

    await importReference(target, NET, source!);

    expect(target.entries.get(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'shielded'))).toBe(WITNESS_SHIELDED);
    expect(target.entries.get(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'dust'))).toBe(WITNESS_DUST);
  });

  it('clears a witness the incoming bundle does not carry', async () => {
    // The dangerous case: this machine had its own witnessed reference. Left in
    // place, those witnesses would be checked against the imported state and
    // pass, certifying cursors they were never taken from.
    const target = withWitnesses(storeWithReference(NET, 2_100_000));
    const unwitnessed = await exportReference(storeWithReference(NET, 2_203_416), NET);

    await importReference(target, NET, unwitnessed!);

    expect(target.entries.has(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'shielded'))).toBe(false);
    expect(target.entries.has(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'dust'))).toBe(false);
  });

  it('replaces a stale witness rather than keeping the older one', async () => {
    const target = withWitnesses(storeWithReference(NET, 2_100_000));
    const source = storeWithReference(NET, 2_203_416);
    source.entries.set(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'dust'), '{"stream":"dust","id":1500000,"hash":"cc"}');
    const bundle = await exportReference(source, NET);

    await importReference(target, NET, bundle!);

    expect(target.entries.get(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'dust'))).toBe(
      '{"stream":"dust","id":1500000,"hash":"cc"}',
    );
    // shielded had no witness in the bundle, so the old one must be gone, not kept.
    expect(target.entries.has(cursorWitnessKey(NET, EMPTY_REF_WALLET, 'shielded'))).toBe(false);
  });
});
