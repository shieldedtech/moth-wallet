import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkConfig } from '@shieldedtech/moth-browser';

// The connector's proving calls with a proof server, through the real core provider: the page
// sends one proof's key material under the location the ledger names (a midnight-js 5 dApp's
// `contract:` location, or a bare circuit id from midnight-js 4), and none for the ledger's own
// circuits. The mobile engine runs this same wallet worker.

vi.mock('@shieldedtech/moth-browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shieldedtech/moth-browser')>()),
  createMothBrowser: () => ({}),
}));

import { provingProviderProve } from '../lib/offscreen/wallet-host';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../core/tests/fixtures/zkir');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const material = (version: 'v2' | 'v3') => ({
  zkir: fixture(`mintUnshielded.${version}.bzkir`),
  proverKey: new Uint8Array([1, 2, 3]),
  verifierKey: fixture(`mintUnshielded.${version}.verifier`),
});
const LEDGER9_LOCATION =
  'contract:48a70ff93598190df21753af31c0f495e41ab0041b4daf781ac1d6929e09da4c/mintUnshielded?vk=831ff576a35706008d69c5a16d457ffd6a23209fb86b251caceaf903d8ac02ac';

const PROOF = new Uint8Array([7, 7, 7]);
const bodies: Buffer[] = [];
let server: Server;
let network: NetworkConfig;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      res.writeHead(200).end(Buffer.from(PROOF));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  network = { id: 'undeployed', nodeUrl: url, indexerUrl: url, prover: { type: 'server', url } } as NetworkConfig;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  bodies.length = 0;
});

describe('connector proving with a proof server', () => {
  it("proves a midnight-js 5 dApp's contract circuit with the keys sent for its `contract:` location", async () => {
    const keys = material('v3');
    await expect(
      provingProviderProve(network, fixture('ledger9-call.v9.preimage'), LEDGER9_LOCATION, keys),
    ).resolves.toEqual(PROOF);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.includes(Buffer.from(keys.zkir))).toBe(true);
  });

  it("proves a midnight-js 4 dApp's contract circuit named by its bare circuit id", async () => {
    const keys = material('v2');
    await expect(
      provingProviderProve(network, fixture('ledger8-call.v8.preimage'), 'mintUnshielded', keys),
    ).resolves.toEqual(PROOF);
    expect(bodies[0]!.includes(Buffer.from(keys.zkir))).toBe(true);
  });

  it("leaves the ledger's own circuits, sent without key material, to the proof server", async () => {
    await expect(
      provingProviderProve(network, fixture('ledger9-call.v9.preimage'), 'midnight/zswap/output', null),
    ).resolves.toEqual(PROOF);
    expect(bodies).toHaveLength(1);
  });
});
