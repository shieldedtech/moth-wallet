import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initLedger, ledgerFor } from '../../../src/ledger/index.js';
import {
  bucketOf,
  bucketsFor,
  canonicalDecimals,
  createGloamRegistryClient,
  formatTokenUnits,
  launchColorOf,
  launchDomainSeparator,
  parseRegistryUrl,
  parseTokenList,
  registryPaths,
  resolveHeldTokens,
  shortColor,
  verifiedName,
  verifyColor,
  verifyEntry,
  type ChainView,
  type GloamTokenEntry,
  type RawTokenTypeFn,
} from '../../../src/registry/gloam-registry.js';

// Vectors generated with the Gloam SDK (tokenColorOf from gloam/sdk/src/index.ts,
// which calls the compiled contract's pureCircuits.token_domain and
// compact-runtime 0.20 rawTokenType):
//
//   npx tsx -e "import { tokenColorOf } from './sdk/src/index.ts'; ..."
const CONTRACT = '9dccd8ff1c4614dd5c5291389e3a228b83c34f958a2e10ee92833906fa5ff735';
const LAUNCH_1 = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const DOMAIN_1 = '934d0a29634a5879687f088403f1bc2fed7e32b4bc4b1c8e3375009907363410';
const COLOR_1 = '227df138951ebd0a632ea5bf0f4c1ae64bf6e3771549562410b2204369e67b24';
const CONTRACT_2 = '0000000000000000000000000000000000000000000000000000000000000001';
const LAUNCH_2 = 'ab'.repeat(32);
const COLOR_2 = '20feb108ac88b8070470c4bfc70da39c5c9f2d9084eded1e188de1336d16ea6e';
// rawTokenType(pad32("sNIGHT-v1"), CONTRACT)
const QUOTE_COLOR = '25af894fbe86fa5d65af67c93b2f3fede7484bb0d1d2faeced5fb96b2422c588';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** A canonical metadata document and its digest, as the registry ships them (R-5). */
const metaDoc = (name: string) => {
  const metadataJson = JSON.stringify({ name, schema: 'gloam.metadata/v1', ticker: 'GLOW' });
  return { metadataJson, metadataDigest: sha(metadataJson) };
};

let rawTokenType: RawTokenTypeFn;

beforeAll(async () => {
  await initLedger('v9');
  rawTokenType = ledgerFor('v9').rawTokenType;
});

const launchEntry = (over: Partial<GloamTokenEntry> = {}): GloamTokenEntry => ({
  color: COLOR_1,
  kind: 'launch',
  contract: CONTRACT,
  launch: LAUNCH_1,
  ticker: 'GLOW',
  // As the registry ships it: the name plus the metadata document it was read from.
  name: 'Glow Worm',
  decimals: 6,
  ...metaDoc('Glow Worm'),
  ...over,
});

const quoteEntry: GloamTokenEntry = { color: QUOTE_COLOR, kind: 'quote', contract: CONTRACT, ticker: 'sNIGHT', name: 'Shielded NIGHT', decimals: 0 };

const listBody = (tokens: unknown[]) => ({
  schema: 'gloam.tokenlist/v1',
  contract: CONTRACT,
  generatedAt: '2026-10-11T00:00:00Z',
  version: 7,
  tokens,
});

describe('colour derivation port', () => {
  it('domain separator is SHA-256(pad32("gloam:v1:token") || launch), matching token_domain', () => {
    expect(Buffer.from(launchDomainSeparator(hex(LAUNCH_1))).toString('hex')).toBe(DOMAIN_1);
  });

  it('matches the Gloam SDK tokenColorOf vectors (ledger v9)', () => {
    expect(launchColorOf(hex(LAUNCH_1), CONTRACT, rawTokenType)).toBe(COLOR_1);
    expect(launchColorOf(hex(LAUNCH_2), CONTRACT_2, rawTokenType)).toBe(COLOR_2);
  });

  it('ledger v8 derives the same colours', async () => {
    await initLedger('v8');
    const v8 = ledgerFor('v8').rawTokenType;
    expect(launchColorOf(hex(LAUNCH_1), CONTRACT, v8)).toBe(COLOR_1);
    await initLedger('v9');
  });

  it('rejects a launch id that is not 32 bytes', () => {
    expect(() => launchDomainSeparator(new Uint8Array(31))).toThrow();
  });
});

describe('parseTokenList', () => {
  it('parses a valid list and drops images and unknown fields', () => {
    const list = parseTokenList(listBody([{ ...launchEntry(), image: 'ipfs://bafy', phase: 'curve', verification: {} }]));
    expect(list.version).toBe(7);
    expect(list.rejected).toBe(0);
    expect(list.tokens).toEqual([launchEntry()]);
    expect(list.tokens[0]).not.toHaveProperty('image');
  });

  it('rejects a wrong schema', () => {
    expect(() => parseTokenList({ ...listBody([]), schema: 'other/v1' })).toThrow(/schema/);
  });

  it('drops malformed entries and counts them', () => {
    const list = parseTokenList(
      listBody([
        launchEntry(),
        { ...launchEntry(), color: 'XYZ' },
        { ...launchEntry(), launch: undefined },
        { ...launchEntry(), kind: 'other' },
        { ...launchEntry(), decimals: 1.5 },
        { ...launchEntry(), ticker: '' },
      ]),
    );
    expect(list.tokens).toHaveLength(1);
    expect(list.rejected).toBe(5);
  });

  it('strips control and bidi characters from ticker and name', () => {
    const list = parseTokenList(listBody([launchEntry({ ticker: 'GL‮OW\n', name: undefined, ...metaDoc('Glow\u0000 Worm') })]));
    expect(list.tokens[0]!.ticker).toBe('GLOW');
    expect(list.tokens[0]!.name).toBe('Glow Worm');
  });

  it('R-5: takes the name only from metadata that hashes to the digest, never from the name field', () => {
    const doc = metaDoc('Glow Worm');
    expect(parseTokenList(listBody([launchEntry({ name: undefined, ...doc })])).tokens[0]!.name).toBe('Glow Worm');
    // A bare registry name is ignored.
    expect(parseTokenList(listBody([launchEntry({ name: 'Real Token', metadataJson: undefined, metadataDigest: undefined })])).tokens[0]).not.toHaveProperty('name');
    // Swapping the name inside the document breaks the hash.
    const forged = { ...doc, metadataJson: doc.metadataJson.replace('Glow Worm', 'Real Token') };
    expect(parseTokenList(listBody([launchEntry({ name: 'Real Token', ...forged })])).tokens[0]).not.toHaveProperty('name');
    expect(verifiedName(doc.metadataJson, doc.metadataDigest)).toBe('Glow Worm');
    expect(verifiedName('{"schema":"other","name":"x"}', sha('{"schema":"other","name":"x"}'))).toBeUndefined();
  });
});

describe('bucket selection', () => {
  const held = [COLOR_1, COLOR_2, QUOTE_COLOR, 'f'.repeat(64)];

  it('buckets by first hex digit', () => {
    expect(bucketOf(COLOR_1)).toBe('2');
    expect(bucketsFor(held)).toEqual(['2', 'f']);
  });

  it('full-list mode is a single path regardless of holdings', () => {
    expect(registryPaths(held, false)).toEqual(['/v1/tokens']);
  });

  it('bucket mode requests only held buckets, never a colour', () => {
    const paths = registryPaths(held, true);
    expect(paths).toEqual(['/v1/tokens/buckets/2', '/v1/tokens/buckets/f']);
    for (const p of paths) for (const c of held) expect(p).not.toContain(c.slice(0, 8));
  });

  it('requests nothing when no shielded colours are held', () => {
    expect(registryPaths([], true)).toEqual([]);
    expect(registryPaths(['0'.repeat(10)], false)).toEqual([]);
  });
});

describe('verification', () => {
  it('passes colour verification for a correct launch entry', () => {
    expect(verifyColor(launchEntry(), rawTokenType)).toEqual({ level: 'colour-verified' });
  });

  it('fails when the colour does not derive from (launch, contract)', () => {
    expect(verifyColor(launchEntry({ color: COLOR_2 }), rawTokenType).level).toBe('unverified');
    expect(verifyColor(launchEntry({ contract: CONTRACT_2 }), rawTokenType).level).toBe('unverified');
    expect(verifyColor(launchEntry({ launch: LAUNCH_2 }), rawTokenType).level).toBe('unverified');
  });

  it('verifies the sNIGHT quote colour by derivation', () => {
    expect(verifyColor(quoteEntry, rawTokenType).level).toBe('colour-verified');
    expect(verifyColor({ ...quoteEntry, contract: CONTRACT_2 }, rawTokenType).level).toBe('unverified');
  });

  it('chain-verifies when launch_info matches, and fails on a mismatch', async () => {
    const chain = (info?: { ticker: string; metadataDigest: string }): ChainView => ({ launchInfo: async () => info });
    const digest = 'cd'.repeat(32);
    const entry = launchEntry({ metadataDigest: digest });
    expect((await verifyEntry(entry, rawTokenType, chain({ ticker: 'GLOW', metadataDigest: digest }))).level).toBe('chain-verified');
    expect(await verifyEntry(entry, rawTokenType, chain(undefined))).toEqual({ level: 'unverified', reason: 'launch not on chain' });
    expect((await verifyEntry(entry, rawTokenType, chain({ ticker: 'FAKE', metadataDigest: digest }))).level).toBe('unverified');
    expect((await verifyEntry(entry, rawTokenType, chain({ ticker: 'GLOW', metadataDigest: '00'.repeat(32) }))).level).toBe('unverified');
  });

  it('resolves only held colours; unverified entries get no name and raw decimals; verified get canonical decimals', async () => {
    const forged = launchEntry({ color: 'f'.repeat(64), ticker: 'GLOW', name: 'Fake Glow', decimals: 2 });
    const notHeld = launchEntry({ color: COLOR_2, launch: LAUNCH_2, contract: CONTRACT_2 });
    const out = await resolveHeldTokens(
      [launchEntry({ decimals: 0 }), forged, notHeld, quoteEntry],
      [COLOR_1, 'f'.repeat(64), QUOTE_COLOR],
      rawTokenType,
    );
    expect(Object.keys(out).sort()).toEqual([COLOR_1, QUOTE_COLOR, 'f'.repeat(64)].sort());
    expect(out[COLOR_1]).toMatchObject({ ticker: 'GLOW', name: 'Glow Worm', decimals: 6, level: 'colour-verified' });
    expect(out['f'.repeat(64)]).toMatchObject({ ticker: 'GLOW', decimals: 0, level: 'unverified' });
    expect(out['f'.repeat(64)]).not.toHaveProperty('name');
    expect(out[QUOTE_COLOR]).toMatchObject({ ticker: 'sNIGHT', name: 'Shielded NIGHT', decimals: 0, level: 'colour-verified' });
  });

  it('prefers a verified entry when two claim the same colour', async () => {
    const impostor = launchEntry({ launch: LAUNCH_2, ticker: 'EVIL' });
    const out = await resolveHeldTokens([impostor, launchEntry()], [COLOR_1], rawTokenType);
    expect(out[COLOR_1]).toMatchObject({ ticker: 'GLOW', level: 'colour-verified' });
  });
});

describe('decimals formatting', () => {
  it('uses 6 decimals for launch tokens and 0 for sNIGHT', () => {
    expect(canonicalDecimals('launch')).toBe(6);
    expect(canonicalDecimals('quote')).toBe(0);
    expect(formatTokenUnits(1_234_500n, 6)).toBe('1.2345');
    expect(formatTokenUnits(1_000_000n, 6)).toBe('1');
    expect(formatTokenUnits(5n, 6)).toBe('0.000005');
    expect(formatTokenUnits(42n, 0)).toBe('42');
  });

  it('short colour is the first 8 hex digits', () => {
    expect(shortColor(COLOR_1)).toBe('227df138…');
  });
});

describe('registry client', () => {
  const ok = (body: unknown, etag: string) =>
    new Response(JSON.stringify(body), { status: 200, headers: { etag, 'content-type': 'application/json' } });

  it('validates the base URL', () => {
    expect(parseRegistryUrl('http://localhost:8790/')).toBe('http://localhost:8790');
    expect(parseRegistryUrl('file:///etc/passwd')).toBeNull();
    expect(parseRegistryUrl('http://user:pw@host')).toBeNull();
    expect(() => createGloamRegistryClient({ baseUrl: 'ftp://x' })).toThrow();
  });

  it('fetches the full list once and revalidates with If-None-Match', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(listBody([launchEntry()]), '"v7"'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const client = createGloamRegistryClient({ baseUrl: 'http://localhost:8790', fetch: fetchMock });

    expect(await client.entriesFor([COLOR_1, QUOTE_COLOR])).toEqual([launchEntry()]);
    expect(await client.entriesFor([COLOR_1])).toEqual([launchEntry()]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0]!;
    const [url2, init2] = fetchMock.mock.calls[1]!;
    expect(url1).toBe('http://localhost:8790/v1/tokens');
    expect(url2).toBe('http://localhost:8790/v1/tokens');
    expect(init1!.headers).toEqual({ accept: 'application/json' });
    expect(init2!.headers).toEqual({ accept: 'application/json', 'if-none-match': '"v7"' });
    expect(init1!.credentials).toBe('omit');
    expect(init1!.referrerPolicy).toBe('no-referrer');
  });

  it('in bucket mode requests only the held buckets', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok(listBody([]), '"v1"'));
    const client = createGloamRegistryClient({ baseUrl: 'http://localhost:8790', useBuckets: true, fetch: fetchMock });
    await client.entriesFor([COLOR_1, COLOR_2, 'a'.repeat(64)]);
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).sort();
    expect(urls).toEqual(['http://localhost:8790/v1/tokens/buckets/2', 'http://localhost:8790/v1/tokens/buckets/a']);
  });

  it('makes no request when nothing shielded is held', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createGloamRegistryClient({ baseUrl: 'http://localhost:8790', fetch: fetchMock });
    expect(await client.entriesFor([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces registry errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"error":"warming"}', { status: 503 }));
    const client = createGloamRegistryClient({ baseUrl: 'http://localhost:8790', fetch: fetchMock });
    await expect(client.entriesFor([COLOR_1])).rejects.toThrow(/503/);
  });
});
