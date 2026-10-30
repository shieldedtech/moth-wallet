// Injected into DApp pages in Moth's in-app browser: installs `window.midnight.moth`, the
// dapp-connector-api InitialAPI, as packages/extension/entrypoints/injected.ts does in a tab.
// Calls go to Swift over the `mothConnector` reply handler, which adds the frame's origin.
import type { ConnectedAPI, InitialAPI, KeyMaterialProvider, ProvingProvider } from '@midnight-ntwrk/dapp-connector-api';
import { decodeBigintJson, encodeBigintJson } from 'moth-ext/messaging/bigint-json';
import { connectorError } from 'moth-ext/connector/errors';
import {
  API_VERSION,
  EXTENSION_METHODS,
  IMPLEMENTED_METHODS,
  WALLET_ICON,
  WALLET_ID,
  WALLET_NAME,
  WALLET_RDNS,
} from 'moth-ext/connector/constants';

type Reply = { ok: true; resultJson: string } | { ok: false; error: { code: never; reason: string } };

// Captured now, so a page cannot swap the channel out after load.
const handler = (window as unknown as {
  webkit?: { messageHandlers?: { mothConnector?: { postMessage(v: unknown): Promise<string> } } };
}).webkit?.messageHandlers?.mothConnector;
const post = handler?.postMessage.bind(handler);

async function request(method: string, args: unknown[]): Promise<unknown> {
  if (!post) throw connectorError('Disconnected', 'Moth is not available in this page');
  const reply = JSON.parse(await post({ method, paramsJson: encodeBigintJson(args) })) as Reply;
  if (!reply.ok) throw connectorError(reply.error.code, reply.error.reason);
  return decodeBigintJson(reply.resultJson);
}

function buildConnectedApi(): ConnectedAPI {
  const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of [...IMPLEMENTED_METHODS, ...EXTENSION_METHODS]) {
    if (method !== 'getProvingProvider') api[method] = (...args: unknown[]) => request(method, args);
  }

  // Functions cannot cross to Swift, so key material is fetched here for each proof.
  api.getProvingProvider = async (candidate: unknown): Promise<ProvingProvider> => {
    const keys = candidate as Partial<KeyMaterialProvider> | null;
    if (!keys || typeof keys.getZKIR !== 'function' || typeof keys.getProverKey !== 'function' || typeof keys.getVerifierKey !== 'function') {
      throw connectorError('InvalidRequest', 'getProvingProvider requires a KeyMaterialProvider');
    }
    await request('getProvingProvider', []);
    const materialFor = async (keyLocation: string) => {
      const [zkir, proverKey, verifierKey] = await Promise.all([
        keys.getZKIR!(keyLocation),
        keys.getProverKey!(keyLocation),
        keys.getVerifierKey!(keyLocation),
      ]);
      return { zkir, proverKey, verifierKey };
    };
    return Object.freeze({
      async check(serializedPreimage: Uint8Array, keyLocation: string) {
        return (await request('provingProviderCheck', [serializedPreimage, keyLocation, await materialFor(keyLocation)])) as (bigint | undefined)[];
      },
      async prove(serializedPreimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint) {
        const params = [serializedPreimage, keyLocation, await materialFor(keyLocation), overwriteBindingInput];
        return (await request('provingProviderProve', params)) as Uint8Array;
      },
    });
  };
  return Object.freeze(api) as unknown as ConnectedAPI;
}

const initialApi: InitialAPI = Object.freeze({
  rdns: WALLET_RDNS,
  name: WALLET_NAME,
  icon: WALLET_ICON,
  apiVersion: API_VERSION,
  async connect(networkId: string): Promise<ConnectedAPI> {
    await request('connect', [networkId]);
    return buildConnectedApi();
  },
});

const root = window as unknown as { midnight?: Record<string, unknown> };
root.midnight = root.midnight ?? {};
Object.defineProperty(root.midnight, WALLET_ID, { value: initialApi, writable: false, configurable: false, enumerable: true });
