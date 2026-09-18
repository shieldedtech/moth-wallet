import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync, gzipSync} from 'node:zlib';
import {afterEach, describe, expect, it} from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {collapseDustReference, inspectDustSnapshot} from '../../../src/sync/dust-reference-collapse.js';

const {collapseBundle, BundleCheckError} = (await import('../../../../../scripts/lib/collapse-preseed.mjs')) as {
  collapseBundle: (dir: string, deps: Record<string, unknown>) => Record<string, unknown>;
  BundleCheckError: new (message: string) => Error;
};

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/preseed/${name}`, import.meta.url));
const REFERENCE = gunzipSync(fixture('preview-519470-dust.dat.gz')).toString('utf8');
const MANIFEST = JSON.parse(fixture('preview-519470-manifest.json').toString('utf8')) as Record<string, unknown>;

const deps = (extra: Record<string, unknown> = {}) => ({collapseDustReference, inspectDustSnapshot, ...extra});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

/** A bundle directory as export-preseed writes it, around the recorded preview dust state. */
function bundle(options: {dust?: string; manifest?: (m: Record<string, unknown>) => void} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'moth-collapse-bundle-'));
  dirs.push(dir);
  const parts: Record<string, string> = {
    shielded: '{"shielded":"state"}',
    unshielded: '{"unshielded":"state"}',
    dust: options.dust ?? REFERENCE,
  };
  const manifest = structuredClone(MANIFEST) as {parts: Record<string, unknown>};
  for (const [part, json] of Object.entries(parts)) {
    const gz = gzipSync(Buffer.from(json), {level: 9});
    writeFileSync(join(dir, `${part}.dat.gz`), gz);
    manifest.parts[part] = {bytes: Buffer.byteLength(json), gzipBytes: gz.byteLength};
  }
  options.manifest?.(manifest);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const files = (dir: string) =>
  Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]));

function expectRefused(dir: string, extra: Record<string, unknown>, pattern: RegExp): void {
  const before = files(dir);
  let thrown: unknown;
  try {
    collapseBundle(dir, deps(extra));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(BundleCheckError);
  expect((thrown as Error).message).toMatch(pattern);
  expect(files(dir)).toEqual(before);
}

describe('collapseBundle', () => {
  it('collapses the dust state and records its new size, changing nothing else', () => {
    const dir = bundle();
    const before = files(dir);

    const report = collapseBundle(dir, deps({network: 'preview'}));

    expect(report).toMatchObject({network: 'preview', height: 519_470, cursor: '141062', changed: true, wrote: true});
    const after = files(dir);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after['shielded.dat.gz']).toEqual(before['shielded.dat.gz']);
    expect(after['unshielded.dat.gz']).toEqual(before['unshielded.dat.gz']);

    const dust = gunzipSync(after['dust.dat.gz']!).toString('utf8');
    const summary = inspectDustSnapshot(dust);
    expect(summary.stateBytes).toBeLessThan(8_192);
    expect(summary.generationRoot).toBe(inspectDustSnapshot(REFERENCE).generationRoot);

    const manifestBefore = JSON.parse(before['manifest.json']!.toString('utf8'));
    const manifestAfter = JSON.parse(after['manifest.json']!.toString('utf8'));
    expect(manifestAfter.parts.dust).toEqual({bytes: Buffer.byteLength(dust), gzipBytes: after['dust.dat.gz']!.byteLength});
    expect({...manifestAfter, parts: {...manifestAfter.parts, dust: null}}).toEqual({
      ...manifestBefore,
      parts: {...manifestBefore.parts, dust: null},
    });
  });

  it('does nothing to a bundle that is already collapsed', () => {
    const dir = bundle();
    collapseBundle(dir, deps());
    const collapsed = files(dir);

    const again = collapseBundle(dir, deps());

    expect(again).toMatchObject({changed: false, wrote: false});
    expect(files(dir)).toEqual(collapsed);
  });

  it('with check, passes a collapsed bundle', () => {
    const dir = bundle();
    collapseBundle(dir, deps());
    expect(collapseBundle(dir, deps({check: true}))).toMatchObject({changed: false, wrote: false});
  });

  it('with check, fails an uncollapsed bundle and writes nothing', () => {
    expectRefused(bundle(), {check: true}, /not collapsed/);
  });

  it('with check, fails a manifest that misstates the dust file it ships', () => {
    const dir = bundle();
    collapseBundle(dir, deps());
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.parts.dust.gzipBytes += 1;
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    expectRefused(dir, {check: true}, /does not record the dust\.dat\.gz/);
  });

  describe('refuses, and writes nothing, when', () => {
    it('the manifest is for another network', () => {
      expectRefused(bundle(), {network: 'preprod'}, /not preprod/);
    });

    it('a witness is missing or malformed', () => {
      expectRefused(bundle({manifest: (m) => delete (m.witnesses as Record<string, unknown>).dust}), {}, /dust witness/);
      expectRefused(
        bundle({manifest: (m) => ((m.witnesses as Record<string, {digest: string}>).shielded.digest = 'nope')}),
        {},
        /shielded witness/,
      );
    });

    it('a part is missing', () => {
      const dir = bundle();
      rmSync(join(dir, 'unshielded.dat.gz'));
      expectRefused(dir, {}, /missing unshielded\.dat\.gz/);
    });

    it('the manifest misstates a part it does not rewrite', () => {
      expectRefused(bundle({manifest: (m) => ((m.parts as Record<string, {bytes: number}>).shielded.bytes = 1)}), {}, /shielded\.dat\.gz/);
    });

    it('the dust state owns DUST', () => {
      const state = ledger.DustLocalState.deserialize(Buffer.from(JSON.parse(REFERENCE).state, 'hex')).addUtxo(1n, {
        initialValue: 0n,
        owner: 0n,
        nonce: 0n,
        seq: 0,
        ctime: new Date(0),
        backingNight: '00'.repeat(32),
        mtIndex: 0n,
      } as ledger.QualifiedDustOutput);
      const owning = REFERENCE.replace(/"state":"[0-9a-f]*"/, `"state":"${Buffer.from(state.serialize()).toString('hex')}"`);
      expectRefused(bundle({dust: owning}), {}, /owns no DUST|UTXO/);
    });

    it('the dust state has no usable cursor', () => {
      expectRefused(bundle({dust: REFERENCE.replace('"offset":"141062"', '"offset":"0"')}), {}, /no usable cursor/);
    });
  });
});
