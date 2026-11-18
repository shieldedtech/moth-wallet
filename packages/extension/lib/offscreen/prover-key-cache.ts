// Prover keys a dApp has sent, held by SHA-256 so a proof names its key instead of carrying it: a
// compactc 0.36 key runs to tens of MB, and one over ~48 MB cannot cross Chrome's 64 MiB message cap.
// Held per origin, so one site cannot learn which contracts another site's page has proved with.

import { PROVER_KEY_NOT_HELD } from '../connector/constants';
import type { ProvingKeyMaterialDTO, ProvingKeyMaterialRefDTO } from './messaging';

/** Room for the largest keys of a couple of contracts; the least recently used go first. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Uploads a page may have open at once; the oldest is dropped beyond this. */
const MAX_OPEN_UPLOADS = 8;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ProverKeyChunk {
  readonly sha256: string;
  /** Names one upload, so two that send the same key at once do not interleave. */
  readonly uploadId: string;
  readonly index: number;
  readonly count: number;
  readonly chunk: Uint8Array;
}

interface OpenUpload {
  readonly sha256: string;
  readonly count: number;
  readonly parts: Uint8Array[];
  bytes: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isProverKeyRef(
  material: ProvingKeyMaterialDTO | ProvingKeyMaterialRefDTO | null,
): material is ProvingKeyMaterialRefDTO {
  return material !== null && 'proverKeySha256' in material;
}

export class ProverKeyCache {
  /** Map order is recency order: the first entry is the least recently used. */
  readonly #held = new Map<string, Uint8Array>();
  readonly #open = new Map<string, OpenUpload>();
  #bytes = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  /** Adds one chunk of an upload; resolves `true` once the key is complete, checked and held. */
  async put(origin: string, part: ProverKeyChunk): Promise<boolean> {
    if (!SHA256_HEX.test(part.sha256)) throw new Error('Prover key upload needs a lowercase hex SHA-256');
    if (!Number.isInteger(part.count) || part.count < 1 || !Number.isInteger(part.index)) {
      throw new Error('Prover key upload has an invalid chunk index or count');
    }
    const slot = `${origin}\n${part.uploadId}`;
    if (part.index === 0) {
      this.#open.delete(slot);
      this.#open.set(slot, { sha256: part.sha256, count: part.count, parts: [], bytes: 0 });
      while (this.#open.size > MAX_OPEN_UPLOADS) this.#open.delete(this.#open.keys().next().value!);
    }
    const upload = this.#open.get(slot);
    if (!upload || upload.sha256 !== part.sha256 || upload.count !== part.count || part.index !== upload.parts.length) {
      this.#open.delete(slot);
      throw new Error('Prover key upload chunk arrived out of order');
    }
    upload.parts.push(part.chunk);
    upload.bytes += part.chunk.length;
    if (upload.bytes > this.maxBytes) {
      this.#open.delete(slot);
      throw new Error(`Prover key is larger than the wallet holds (${this.maxBytes} bytes)`);
    }
    if (upload.parts.length < upload.count) return false;

    this.#open.delete(slot);
    const key = new Uint8Array(upload.bytes);
    let at = 0;
    for (const p of upload.parts) {
      key.set(p, at);
      at += p.length;
    }
    if ((await sha256Hex(key)) !== part.sha256) throw new Error('Prover key does not match its SHA-256');
    this.#hold(`${origin}\n${part.sha256}`, key);
    return true;
  }

  /** The held key, made most recently used; throws {@link PROVER_KEY_NOT_HELD} when it is not held. */
  get(origin: string, sha256: string): Uint8Array {
    const id = `${origin}\n${sha256}`;
    const key = this.#held.get(id);
    if (!key) throw new Error(`${PROVER_KEY_NOT_HELD}: ${sha256}`);
    this.#held.delete(id);
    this.#held.set(id, key);
    return key;
  }

  /** Key material as the prover takes it, with a referenced prover key filled in. */
  resolve(
    origin: string,
    material: ProvingKeyMaterialDTO | ProvingKeyMaterialRefDTO | null,
  ): ProvingKeyMaterialDTO | null {
    if (!isProverKeyRef(material)) return material;
    return {
      zkir: material.zkir,
      verifierKey: material.verifierKey,
      proverKey: this.get(origin, material.proverKeySha256),
    };
  }

  get heldBytes(): number {
    return this.#bytes;
  }

  #hold(id: string, key: Uint8Array): void {
    const previous = this.#held.get(id);
    if (previous) {
      this.#held.delete(id);
      this.#bytes -= previous.length;
    }
    while (this.#held.size > 0 && this.#bytes + key.length > this.maxBytes) {
      const [oldest, bytes] = this.#held.entries().next().value!;
      this.#held.delete(oldest);
      this.#bytes -= bytes.length;
    }
    this.#held.set(id, key);
    this.#bytes += key.length;
  }
}
