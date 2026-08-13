// MAIN-world provider: installs window.midnight.moth implementing the
// Midnight dApp connector InitialAPI. Every call is forwarded to the
// background through the content-script relay; no wallet state lives here.

import { defineUnlistedScript } from '#imports';
import type {
  InitialAPI,
  ConnectedAPI,
  KeyMaterialProvider,
  ProvingProvider,
} from '@midnight-ntwrk/dapp-connector-api';
import { encodeBigintJson, decodeBigintJson } from '../lib/messaging/bigint-json';
import { createPageClient, type PageClient } from '../lib/messaging/page-transport';
import { connectorError } from '../lib/connector/errors';
import {
  WALLET_ID,
  WALLET_RDNS,
  WALLET_NAME,
  WALLET_ICON,
  API_VERSION,
  IMPLEMENTED_METHODS,
  NOT_IMPLEMENTED_METHODS,
  EXTENSION_METHODS,
} from '../lib/connector/constants';

function buildConnectedApi(client: PageClient): ConnectedAPI {
  const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // EXTENSION_METHODS (e.g. deriveAppSecret) aren't in the connector-api type;
  // they're exposed at runtime so DApps can call them via a cast.
  for (const method of [...IMPLEMENTED_METHODS, ...NOT_IMPLEMENTED_METHODS, ...EXTENSION_METHODS]) {
    if (method === 'getProvingProvider') continue;
    api[method] = async (...args: unknown[]) =>
      decodeBigintJson(await client.request(method, encodeBigintJson(args)));
  }

  // Functions cannot cross the page/content-script/runtime JSON boundary.
  // Keep the standard ProvingProvider object in the page and proxy each binary
  // operation to the wallet after resolving the dApp's key material locally.
  api.getProvingProvider = async (candidate: unknown): Promise<ProvingProvider> => {
    const keys = candidate as Partial<KeyMaterialProvider> | null;
    if (
      !keys ||
      typeof keys.getZKIR !== 'function' ||
      typeof keys.getProverKey !== 'function' ||
      typeof keys.getVerifierKey !== 'function'
    ) {
      throw connectorError('InvalidRequest', 'getProvingProvider requires a KeyMaterialProvider');
    }
    await client.request('getProvingProvider', encodeBigintJson([]));

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
        const params = [serializedPreimage, keyLocation, await materialFor(keyLocation)];
        return decodeBigintJson<(bigint | undefined)[]>(
          await client.request('provingProviderCheck', encodeBigintJson(params)),
        );
      },
      async prove(serializedPreimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint) {
        const params = [
          serializedPreimage,
          keyLocation,
          await materialFor(keyLocation),
          overwriteBindingInput,
        ];
        return decodeBigintJson<Uint8Array>(
          await client.request('provingProviderProve', encodeBigintJson(params)),
        );
      },
    });
  };
  return Object.freeze(api) as unknown as ConnectedAPI;
}

export default defineUnlistedScript(() => {
  const client = createPageClient(
    window,
    (handler) => window.addEventListener('message', handler),
    ({ code, reason }) => connectorError(code, reason),
  );

  const initialApi: InitialAPI = Object.freeze({
    rdns: WALLET_RDNS,
    name: WALLET_NAME,
    icon: WALLET_ICON,
    apiVersion: API_VERSION,
    async connect(networkId: string): Promise<ConnectedAPI> {
      await client.request('connect', encodeBigintJson([networkId]));
      return buildConnectedApi(client);
    },
  });

  window.midnight = window.midnight ?? {};
  Object.defineProperty(window.midnight, WALLET_ID, {
    value: initialApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });
});
