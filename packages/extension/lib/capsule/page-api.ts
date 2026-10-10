// The capsule runtime's dApp API as a page sees it: `window.midnight.moth.capsule`, a
// CapsuleConnector over the same relay as the standard connector. Every method is one request;
// `onCapsuleEvent` asks the wallet to watch a session and hears what it pushes back. A refusal
// arrives as the blueprint's own code, reason and path and is rethrown as a BlueprintError, so
// `@shieldedtech/capsule-dapp-sdk` runs over this unchanged.
//
// MAIN world: nothing here holds wallet state or trusts anything but the relay.

import { BlueprintError, type CapsuleConnector, type CapsuleEvent } from '@shieldedtech/capsule-blueprint';
import { decodeBigintJson, encodeBigintJson } from '../messaging/bigint-json';
import type { PageClient } from '../messaging/page-transport';
import type { SerializedConnectorError } from '../connector/errors';
import type { CapsuleEventDTO, CapsuleMethod, CapsuleMethodMap } from './protocol';

type Result<M extends CapsuleMethod> = CapsuleMethodMap[M]['result'];
type Params<M extends CapsuleMethod> = CapsuleMethodMap[M]['params'];

/** The relay's error carrying a capsule refusal, as `createPageClient`'s error factory marks it. */
export type CapsuleCarryingError = Error & { capsule?: SerializedConnectorError['capsule'] };

export function buildCapsuleApi(client: PageClient): CapsuleConnector {
  const call = async <M extends CapsuleMethod>(method: M, params: Params<M>): Promise<Result<M>> => {
    try {
      return decodeBigintJson<Result<M>>(await client.request(method, encodeBigintJson(params)));
    } catch (error) {
      const refusal = (error as CapsuleCarryingError).capsule;
      if (refusal !== undefined) {
        throw new BlueprintError(refusal.code as never, refusal.reason as never, refusal.path ?? []);
      }
      throw error;
    }
  };

  const listeners = new Map<string, Set<(event: CapsuleEvent) => void>>();
  client.onEvent((dataJson) => {
    const { session, event } = decodeBigintJson<CapsuleEventDTO>(dataJson);
    for (const listener of listeners.get(session) ?? []) listener(event);
  });

  return Object.freeze({
    connect: (request) => call('capsuleConnect', [request]),
    submitBlueprint: (session, document) => call('capsuleSubmitBlueprint', [session, document]),
    makeBlueprintTransaction: (session, document) => call('capsuleMakeTransaction', [session, document]) as never,
    estimateBlueprint: (session, document) => call('capsuleEstimate', [session, document]) as never,
    readLocalState: (session, request) => call('capsuleReadLocalState', [session, request]),
    disconnect: async (session) => {
      listeners.delete(session);
      await call('capsuleDisconnect', [session]);
    },
    onCapsuleEvent(session, listener) {
      let set = listeners.get(session);
      if (set === undefined) {
        set = new Set();
        listeners.set(session, set);
        void call('capsuleWatch', [session, true]).catch(() => {});
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(session);
          void call('capsuleWatch', [session, false]).catch(() => {});
        }
      };
    },
  } satisfies CapsuleConnector);
}
