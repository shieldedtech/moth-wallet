// The page half of the dApp connector's ProvingProvider: it resolves the dApp's key material in
// the page and asks the wallet to check or prove. A contract's prover key crosses to the wallet
// once, in chunks; after that each request names it by SHA-256.

import type { KeyMaterialProvider, ProvingProvider } from '@midnight-ntwrk/dapp-connector-api';
import { decodeBigintJson, encodeBigintJson } from '../messaging/bigint-json';
import type { PageClient } from '../messaging/page-transport';
import {
  PROVER_KEY_CHUNK_BYTES,
  PROVER_KEY_NOT_HELD,
  isContractKeyLocation,
  isProtocolKeyLocation,
} from './constants';

interface KeyRef {
  readonly zkir: Uint8Array;
  readonly verifierKey: Uint8Array;
  readonly proverKeySha256: string;
}

export interface ProvingProxyOptions {
  /** `undefined` outside a secure context, where every request carries its keys in full. */
  readonly subtle?: SubtleCrypto;
  readonly randomId?: () => string;
  readonly chunkBytes?: number;
}

async function sha256Hex(subtle: SubtleCrypto, bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isNotHeld(err: unknown): boolean {
  const reason = (err as { reason?: unknown } | null)?.reason ?? (err as Error | null)?.message;
  return typeof reason === 'string' && reason.includes(PROVER_KEY_NOT_HELD);
}

export function createProvingProxy(
  client: PageClient,
  keys: KeyMaterialProvider,
  options: ProvingProxyOptions = {},
): ProvingProvider {
  const { subtle, randomId = () => crypto.randomUUID(), chunkBytes = PROVER_KEY_CHUNK_BYTES } = options;
  // A `contract:` location embeds its verifier key's hash, so its keys cannot change under it.
  const refs = new Map<string, Promise<KeyRef>>();
  const uploads = new Map<string, Promise<void>>();
  const uploaded = new Map<string, number>();

  const request = async <T>(method: string, params: unknown[]): Promise<T> =>
    decodeBigintJson<T>(await client.request(method, encodeBigintJson(params)));

  const fullMaterial = async (keyLocation: string) => {
    const [zkir, proverKey, verifierKey] = await Promise.all([
      keys.getZKIR(keyLocation),
      keys.getProverKey(keyLocation),
      keys.getVerifierKey(keyLocation),
    ]);
    return { zkir, proverKey, verifierKey };
  };

  const describe = async (digest: SubtleCrypto, keyLocation: string): Promise<KeyRef> => {
    const { zkir, proverKey, verifierKey } = await fullMaterial(keyLocation);
    return { zkir, verifierKey, proverKeySha256: await sha256Hex(digest, proverKey) };
  };

  const refFor = (digest: SubtleCrypto, keyLocation: string): Promise<KeyRef> => {
    if (!isContractKeyLocation(keyLocation)) return describe(digest, keyLocation);
    let ref = refs.get(keyLocation);
    if (!ref) {
      ref = describe(digest, keyLocation);
      refs.set(keyLocation, ref);
      ref.catch(() => refs.delete(keyLocation));
    }
    return ref;
  };

  // Concurrent proofs of one circuit share a single upload.
  const upload = (digest: SubtleCrypto, keyLocation: string, ref: KeyRef): Promise<void> => {
    let pending = uploads.get(ref.proverKeySha256);
    if (!pending) {
      pending = (async () => {
        const proverKey = await keys.getProverKey(keyLocation);
        if ((await sha256Hex(digest, proverKey)) !== ref.proverKeySha256) {
          refs.delete(keyLocation);
          throw new Error(`The dApp served a different prover key for ${keyLocation} than it hashed`);
        }
        const uploadId = randomId();
        const count = Math.max(1, Math.ceil(proverKey.length / chunkBytes));
        for (let index = 0; index < count; index++) {
          const chunk = proverKey.subarray(index * chunkBytes, (index + 1) * chunkBytes);
          await request('proverKeyPut', [ref.proverKeySha256, uploadId, index, count, chunk]);
        }
        uploaded.set(ref.proverKeySha256, (uploaded.get(ref.proverKeySha256) ?? 0) + 1);
      })().finally(() => uploads.delete(ref.proverKeySha256));
      uploads.set(ref.proverKeySha256, pending);
    }
    return pending;
  };

  const send = async <T>(method: string, preimage: Uint8Array, keyLocation: string, extra: unknown[]) => {
    if (isProtocolKeyLocation(keyLocation)) return request<T>(method, [preimage, keyLocation, null, ...extra]);
    if (!subtle) return request<T>(method, [preimage, keyLocation, await fullMaterial(keyLocation), ...extra]);
    const ref = await refFor(subtle, keyLocation);
    const uploadsBefore = uploaded.get(ref.proverKeySha256) ?? 0;
    try {
      return await request<T>(method, [preimage, keyLocation, ref, ...extra]);
    } catch (err) {
      if (!isNotHeld(err)) throw err;
      // Refused before an upload that has since finished: the key is there now.
      if ((uploaded.get(ref.proverKeySha256) ?? 0) === uploadsBefore) await upload(subtle, keyLocation, ref);
      return request<T>(method, [preimage, keyLocation, ref, ...extra]);
    }
  };

  return Object.freeze({
    check: (serializedPreimage: Uint8Array, keyLocation: string) =>
      send<(bigint | undefined)[]>('provingProviderCheck', serializedPreimage, keyLocation, []),
    prove: (serializedPreimage: Uint8Array, keyLocation: string, overwriteBindingInput?: bigint) =>
      send<Uint8Array>('provingProviderProve', serializedPreimage, keyLocation, [overwriteBindingInput]),
  });
}
