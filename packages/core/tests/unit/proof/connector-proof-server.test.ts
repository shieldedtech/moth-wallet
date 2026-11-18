// The dApp connector's proving provider with a proof server. The connector holds key material
// under the key location the ledger names: a midnight-js 5 dApp's registry serves
// `contract:<address>/<circuit>?vk=<hash>` locations only, and the wallet is handed one proof's
// keys at a time. midnight-js's proof-server client parses such a location and asks by the bare
// circuit id, so the provider has to answer that from the location's keys.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {KeyMaterialProvider} from '@midnight-ntwrk/midnight-js/types';
import {createProvingProvider} from '../../../src/proof/provider.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zkir');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const V3 = {ir: fixture('mintUnshielded.v3.bzkir'), verifierKey: fixture('mintUnshielded.v3.verifier')};
const V2 = {ir: fixture('mintUnshielded.v2.bzkir'), verifierKey: fixture('mintUnshielded.v2.verifier')};
const LEDGER9_PREIMAGE = fixture('ledger9-call.v9.preimage');
const LEDGER8_PREIMAGE = fixture('ledger8-call.v8.preimage');
const LEDGER9_LOCATION =
  'contract:48a70ff93598190df21753af31c0f495e41ab0041b4daf781ac1d6929e09da4c/mintUnshielded?vk=831ff576a35706008d69c5a16d457ffd6a23209fb86b251caceaf903d8ac02ac';

const PROOF = new Uint8Array([7, 7, 7]);
const requests: Array<{path: string; body: Buffer}> = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({path: req.url ?? '', body: Buffer.concat(chunks)});
      res.writeHead(200, {'Content-Type': 'application/octet-stream'}).end(Buffer.from(PROOF));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests.length = 0;
});

/** Key material served under one location only, refusing any other as a midnight-js 5 registry does. */
function servedAt(location: string, keys: {ir: Uint8Array; verifierKey: Uint8Array}): KeyMaterialProvider {
  const serve = async (requested: string, value: Uint8Array) => {
    if (requested !== location) throw new Error(`'${requested}' is not a contract key location`);
    return value;
  };
  return {
    getZKIR: (requested) => serve(requested, keys.ir),
    getProverKey: (requested) => serve(requested, new Uint8Array([1, 2, 3])),
    getVerifierKey: (requested) => serve(requested, keys.verifierKey),
  };
}

const sentKeys = (body: Buffer, ir: Uint8Array) => body.includes(Buffer.from(ir));

describe('createProvingProvider with a proof server (dApp connector)', () => {
  it('sends the keys of a contract circuit named by a `contract:` key location (midnight-js 5)', async () => {
    const provider = createProvingProvider({type: 'server', url}, servedAt(LEDGER9_LOCATION, V3));

    await expect(provider.prove(LEDGER9_PREIMAGE, LEDGER9_LOCATION)).resolves.toEqual(PROOF);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/prove');
    expect(sentKeys(requests[0]!.body, V3.ir)).toBe(true);
  });

  it('sends the keys of a contract circuit named by its bare circuit id (midnight-js 4)', async () => {
    const provider = createProvingProvider({type: 'server', url}, servedAt('mintUnshielded', V2));

    await expect(provider.prove(LEDGER8_PREIMAGE, 'mintUnshielded')).resolves.toEqual(PROOF);

    expect(sentKeys(requests[0]!.body, V2.ir)).toBe(true);
  });

  it("leaves the ledger's own circuits to the proof server", async () => {
    const provider = createProvingProvider({type: 'server', url}, servedAt(LEDGER9_LOCATION, V3));

    await expect(provider.prove(LEDGER9_PREIMAGE, 'midnight/zswap/output')).resolves.toEqual(PROOF);

    expect(requests).toHaveLength(1);
    expect(sentKeys(requests[0]!.body, V3.ir)).toBe(false);
  });

  it("refuses a `contract:` location whose verifier key the dApp's keys do not match, before any request", async () => {
    const provider = createProvingProvider({type: 'server', url}, servedAt(LEDGER9_LOCATION, {ir: V3.ir, verifierKey: V2.verifierKey}));

    await expect(provider.prove(LEDGER9_PREIMAGE, LEDGER9_LOCATION)).rejects.toThrow(/No ZK artifact bundle matches/);
    expect(requests).toHaveLength(0);
  });
});
