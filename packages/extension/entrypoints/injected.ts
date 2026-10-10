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
import { connectorError, type SerializedConnectorError } from '../lib/connector/errors';
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

/**
 * CIP-30 (Cardano dApp-Wallet Web Bridge) provider.
 *
 * Shares the relay and the origin permissions with the Midnight connector but
 * keeps its own method namespace: every call goes out as `cardano.<method>` so
 * a Cardano dApp can never reach a Midnight method, or the reverse.
 *
 * `enable()` returns the full API object only after the user authorizes the
 * origin. The object is built fresh per enable rather than shared, so revoking
 * an origin cannot leave a live API behind in a page that already had one.
 */
const CIP30_METHODS = [
  'getNetworkId',
  'getBalance',
  'getUtxos',
  'getCollateral',
  'getUsedAddresses',
  'getUnusedAddresses',
  'getChangeAddress',
  'getRewardAddresses',
  'getExtensions',
  'signTx',
  'signData',
  'submitTx',
] as const;

function buildCip30Api(client: PageClient): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const method of CIP30_METHODS) {
    api[method] = async (...args: unknown[]) =>
      decodeBigintJson(await client.request(`cardano.${method}`, encodeBigintJson(args)));
  }
  // CIP-30 puts getCollateral under `experimental` on some wallets and at the
  // top level on others. Both point at the same call so either convention works.
  api.experimental = Object.freeze({ getCollateral: api.getCollateral });
  return Object.freeze(api);
}

/**
 * Rebuild a CIP-30 error on the page side.
 *
 * Returned as an Error carrying the spec's fields rather than a bare object:
 * `instanceof Error` holds for dApps that check it, while `code`/`info` — or
 * `maxSize` for a PaginateError — read exactly as the spec says they should.
 * Falling back to the Midnight shape would hand a Cardano dApp a string code
 * that matches none of its branches.
 */
function cip30PageError(error: SerializedConnectorError): Error {
  const wire = error.cip30;
  if (!wire) return connectorError(error.code, error.reason);
  const err = new Error(error.reason);
  err.name = 'maxSize' in wire ? 'PaginateError' : 'APIError';
  return Object.assign(err, wire);
}

export default defineUnlistedScript(() => {
  const listen = (handler: (event: MessageEvent) => void) =>
    window.addEventListener('message', handler);

  const client = createPageClient(window, listen, ({ code, reason }) =>
    connectorError(code, reason),
  );

  // The Cardano provider gets its own client purely so failures reach the page
  // as CIP-30 errors. Two clients can share the window: each correlates on its
  // own request ids and ignores anything it did not send.
  const cardanoClient = createPageClient(window, listen, cip30PageError);

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

  const cardanoApi = Object.freeze({
    apiVersion: '0.1.0',
    name: WALLET_NAME,
    icon: WALLET_ICON,
    supportedExtensions: [],
    async isEnabled(): Promise<boolean> {
      return Boolean(
        decodeBigintJson(await cardanoClient.request('cardano.isEnabled', encodeBigintJson([]))),
      );
    },
    /**
     * `extensions` is accepted and forwarded rather than dropped: CIP-30 lets a
     * dApp ask for extra CIPs here, and one that passes them must not have the
     * argument silently swallowed. moth implements none, so none are granted —
     * `getExtensions` and `supportedExtensions` both say so, and the returned
     * API simply does not carry the extra namespaces.
     */
    async enable(extensions?: readonly { cip: number }[]): Promise<Record<string, unknown>> {
      await cardanoClient.request('cardano.enable', encodeBigintJson([extensions]));
      return buildCip30Api(cardanoClient);
    },
  });

  const cardanoRoot = (window as unknown as { cardano?: Record<string, unknown> });
  cardanoRoot.cardano = cardanoRoot.cardano ?? {};
  Object.defineProperty(cardanoRoot.cardano, WALLET_ID, {
    value: cardanoApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  window.midnight = window.midnight ?? {};
  Object.defineProperty(window.midnight, WALLET_ID, {
    value: initialApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });
});
