// In-process proving hands each circuit to the zkir that reads its IR: zkir-v2 for compactc 0.31
// (ZKIR v2) and zkir-v3 for compactc 0.36 (ZKIR v3). The fixtures are moth-ft's mintUnshielded
// circuit from each compiler, and the preimages the ledger handed the prover for three real calls:
// the ledger-8 contract before the fork (a v8 transaction) and after it (a v9 transaction, still
// ZKIR v2), and the ledger-9 contract (a v9 transaction). zkir's check needs no SRS parameters, so
// the real provers run here offline.

import {afterEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createProverKey,
  createProofProviderFromProvingProviders,
  createVerifierKey,
  createZKIR,
  parseContractKeyLocation,
  ZKConfigProvider,
  ZKConfigRegistry,
} from '@midnight-ntwrk/midnight-js/types';
import {
  createProofProvider,
  createProvingProvider,
  setWasmProvingProviderFactory,
  zkirVersionOf,
  type ProofProviderKit,
  type ZkirVersion,
} from '../../../src/proof/provider.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/zkir');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CIRCUIT = 'mintUnshielded';
const KEYS: Record<ZkirVersion, {ir: Uint8Array; verifierKey: Uint8Array}> = {
  v2: {ir: fixture('mintUnshielded.v2.bzkir'), verifierKey: fixture('mintUnshielded.v2.verifier')},
  v3: {ir: fixture('mintUnshielded.v3.bzkir'), verifierKey: fixture('mintUnshielded.v3.verifier')},
};

/** Each call's preimage, and the key location the ledger named its circuit with. */
const CALLS = [
  {
    name: 'a ledger-8 call before the fork',
    era: 'v8',
    zkir: 'v2',
    preimage: fixture('ledger8-call.v8.preimage'),
    keyLocation:
      'contract:52011692f870de23c725b7eb1b7c36fafacf6c4e55c6b91731b2a7143e825bbf/mintUnshielded?vk=66cbc77579c6a25a6ba9a7ccbb118f9b0fe46c2a7d487dc1d7de01e27d06c1d4',
  },
  {
    name: 'a ledger-8 call after the fork',
    era: 'v9',
    zkir: 'v2',
    preimage: fixture('ledger8-call.v9.preimage'),
    keyLocation:
      'contract:fed657c9bd926cb49ea5cc98605a36b23a9dffea33d94c7032f2163b30e591db/mintUnshielded?vk=66cbc77579c6a25a6ba9a7ccbb118f9b0fe46c2a7d487dc1d7de01e27d06c1d4',
  },
  {
    name: 'a ledger-9 call',
    era: 'v9',
    zkir: 'v3',
    preimage: fixture('ledger9-call.v9.preimage'),
    keyLocation:
      'contract:48a70ff93598190df21753af31c0f495e41ab0041b4daf781ac1d6929e09da4c/mintUnshielded?vk=831ff576a35706008d69c5a16d457ffd6a23209fb86b251caceaf903d8ac02ac',
  },
] as const;

/** A compiled contract's artifacts, served by bare circuit name as NodeZkConfigProvider serves them. */
class FixtureZkConfig extends ZKConfigProvider<string> {
  constructor(private readonly zkir: ZkirVersion) {
    super();
  }
  private keys(circuitId: string) {
    if (circuitId !== CIRCUIT) throw new Error(`Invalid circuitId: "${circuitId}"`);
    return KEYS[this.zkir];
  }
  async getZKIR(circuitId: string) {
    return createZKIR(this.keys(circuitId).ir);
  }
  async getProverKey(circuitId: string) {
    this.keys(circuitId);
    return createProverKey(new Uint8Array());
  }
  async getVerifierKey(circuitId: string) {
    return createVerifierKey(this.keys(circuitId).verifierKey);
  }
}

/** The proving providers createProofProvider hands midnight-js, one per ledger era. */
function provingProvidersOf(zkir: ZkirVersion) {
  let captured: Parameters<typeof createProofProviderFromProvingProviders>[0] | undefined;
  const kit: ProofProviderKit = {
    httpClientProofProvider: () => {
      throw new Error('the in-process path does not reach the proof server');
    },
    createProofProviderFromProvingProviders: (providers) => {
      captured = providers;
      return createProofProviderFromProvingProviders(providers);
    },
    ZKConfigRegistry,
    parseContractKeyLocation,
  };
  createProofProvider({type: 'wasm'}, new FixtureZkConfig(zkir), kit);
  return {v8: captured!.v8!, v9: captured!.v9!};
}

/** Installs a local prover that records which zkir each check was routed to. */
function recordZkirRouting() {
  const routed: Array<{zkir: ZkirVersion; keyLocation: string}> = [];
  const built: ZkirVersion[] = [];
  setWasmProvingProviderFactory((_keys, zkir) => {
    built.push(zkir);
    return {
      check: async (_preimage, keyLocation) => {
        routed.push({zkir, keyLocation});
        return [];
      },
      prove: async (_preimage, keyLocation) => {
        routed.push({zkir, keyLocation});
        return new Uint8Array();
      },
    };
  });
  return {routed, built};
}

afterEach(() => setWasmProvingProviderFactory(null));

describe('zkirVersionOf', () => {
  it('reads the version from the IR header', () => {
    expect(zkirVersionOf(KEYS.v2.ir)).toBe('v2');
    expect(zkirVersionOf(KEYS.v3.ir)).toBe('v3');
  });

  it('leaves anything that is not ZKIR v3 to zkir-v2, as before', () => {
    expect(zkirVersionOf(new TextEncoder().encode('midnight:ir-source[v2-generic]:'))).toBe('v2');
    expect(zkirVersionOf(new Uint8Array())).toBe('v2');
  });
});

describe('createProofProvider in process', () => {
  for (const call of CALLS) {
    it(`routes ${call.name} (ZKIR ${call.zkir}, ${call.era} transaction) to zkir-${call.zkir}`, async () => {
      const {routed} = recordZkirRouting();
      const providers = provingProvidersOf(call.zkir);

      await providers[call.era].check(call.preimage, call.keyLocation);
      await providers[call.era].prove(call.preimage, call.keyLocation);

      expect(routed).toEqual([
        {zkir: call.zkir, keyLocation: call.keyLocation},
        {zkir: call.zkir, keyLocation: call.keyLocation},
      ]);
    });

    it(`checks ${call.name} with the real zkir-${call.zkir}`, async () => {
      const providers = provingProvidersOf(call.zkir);
      const outputs = await providers[call.era].check(call.preimage, call.keyLocation);
      expect(outputs.length).toBeGreaterThan(0);
    });
  }

  it("resolves a ledger-9 key location to the contract's keys through the verifier-key join", async () => {
    const {v9} = provingProvidersOf('v3');
    const ledger9 = CALLS[2];

    const keys = await v9.lookupKey(ledger9.keyLocation);

    expect(keys?.ir).toEqual(KEYS.v3.ir);
    expect(keys?.verifierKey).toEqual(KEYS.v3.verifierKey);
  });

  it('refuses a key location whose verifier key the local artifacts do not match', async () => {
    const {v9} = provingProvidersOf('v3');
    // The ledger-8 call names the ZKIR v2 verifier key, which the ZKIR v3 artifacts do not have.
    await expect(v9.lookupKey(CALLS[1].keyLocation)).rejects.toThrow(/No ZK artifact bundle matches/);
  });
});

describe('createProvingProvider in process (dApp connector)', () => {
  // A midnight-js 5 dApp hands the wallet its registry's key material, which serves each
  // circuit under the key location the ledger names.
  const dappKeys = (call: (typeof CALLS)[number]) => {
    const serve = async (keyLocation: string, value: Uint8Array) => {
      if (keyLocation !== call.keyLocation) throw new Error(`'${keyLocation}' is not a contract key location`);
      return value;
    };
    return {
      getZKIR: (keyLocation: string) => serve(keyLocation, KEYS[call.zkir].ir),
      getProverKey: (keyLocation: string) => serve(keyLocation, new Uint8Array()),
      getVerifierKey: (keyLocation: string) => serve(keyLocation, KEYS[call.zkir].verifierKey),
    };
  };

  for (const call of CALLS) {
    it(`routes ${call.name} to zkir-${call.zkir}, and the real zkir-${call.zkir} checks it`, async () => {
      const {routed} = recordZkirRouting();
      await createProvingProvider({type: 'wasm'}, dappKeys(call)).prove(call.preimage, call.keyLocation);
      expect(routed).toEqual([{zkir: call.zkir, keyLocation: call.keyLocation}]);

      setWasmProvingProviderFactory(null);
      const outputs = await createProvingProvider({type: 'wasm'}, dappKeys(call)).check(call.preimage, call.keyLocation);
      expect(outputs.length).toBeGreaterThan(0);
    });
  }

  it('builds one local prover per ZKIR version, however many circuits it proves', async () => {
    const {routed, built} = recordZkirRouting();
    const byLocation = new Map<string, (typeof CALLS)[number]>(CALLS.map((call) => [call.keyLocation, call]));
    const provider = createProvingProvider(
      {type: 'wasm'},
      {
        getZKIR: async (keyLocation) => KEYS[byLocation.get(keyLocation)!.zkir].ir,
        getProverKey: async () => new Uint8Array(),
        getVerifierKey: async (keyLocation) => KEYS[byLocation.get(keyLocation)!.zkir].verifierKey,
      },
    );

    for (const call of [...CALLS, ...CALLS]) await provider.prove(call.preimage, call.keyLocation);

    expect(built.sort()).toEqual(['v2', 'v3']);
    expect(routed.map(({zkir}) => zkir)).toEqual(['v2', 'v2', 'v3', 'v2', 'v2', 'v3']);
  });
});
