import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROVER_KEY_NOT_HELD } from '../lib/connector/constants';
import { ProverKeyCache } from '../lib/offscreen/prover-key-cache';

const ORIGIN = 'https://dapp.example';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);

async function send(cache: ProverKeyCache, origin: string, bytes: Uint8Array, chunkBytes: number, uploadId = 'u1') {
  const count = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  let done = false;
  for (let index = 0; index < count; index++) {
    const chunk = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    done = await cache.put(origin, { sha256: sha(bytes), uploadId, index, count, chunk });
  }
  return done;
}

describe('ProverKeyCache', () => {
  it('holds a key sent in chunks, under its SHA-256', async () => {
    const cache = new ProverKeyCache();
    const bytes = key(1000);

    await expect(send(cache, ORIGIN, bytes, 300)).resolves.toBe(true);

    expect(cache.get(ORIGIN, sha(bytes))).toEqual(bytes);
    expect(cache.heldBytes).toBe(1000);
  });

  it('refuses a key that does not match its SHA-256', async () => {
    const cache = new ProverKeyCache();
    const bytes = key(10);
    const part = { sha256: sha(key(10, 2)), uploadId: 'u1', index: 0, count: 1, chunk: bytes };

    await expect(cache.put(ORIGIN, part)).rejects.toThrow(/does not match its SHA-256/);
    expect(() => cache.get(ORIGIN, part.sha256)).toThrow(PROVER_KEY_NOT_HELD);
  });

  it('refuses a chunk out of order', async () => {
    const cache = new ProverKeyCache();
    const bytes = key(30);
    const part = { sha256: sha(bytes), uploadId: 'u1', count: 3 };

    await expect(cache.put(ORIGIN, { ...part, index: 1, chunk: bytes.subarray(10, 20) })).rejects.toThrow(
      /out of order/,
    );
    await cache.put(ORIGIN, { ...part, index: 0, chunk: bytes.subarray(0, 10) });
    await expect(cache.put(ORIGIN, { ...part, index: 2, chunk: bytes.subarray(20) })).rejects.toThrow(/out of order/);
  });

  it('keeps two uploads of one key apart', async () => {
    const cache = new ProverKeyCache();
    const bytes = key(20);
    const base = { sha256: sha(bytes), count: 2 };

    await cache.put(ORIGIN, { ...base, uploadId: 'a', index: 0, chunk: bytes.subarray(0, 10) });
    await cache.put(ORIGIN, { ...base, uploadId: 'b', index: 0, chunk: bytes.subarray(0, 10) });
    await expect(cache.put(ORIGIN, { ...base, uploadId: 'a', index: 1, chunk: bytes.subarray(10) })).resolves.toBe(
      true,
    );
    await expect(cache.put(ORIGIN, { ...base, uploadId: 'b', index: 1, chunk: bytes.subarray(10) })).resolves.toBe(
      true,
    );
    expect(cache.heldBytes).toBe(20);
  });

  it("does not answer one origin with another's key", async () => {
    const cache = new ProverKeyCache();
    const bytes = key(10);
    await send(cache, ORIGIN, bytes, 10);

    expect(() => cache.get('https://other.example', sha(bytes))).toThrow(PROVER_KEY_NOT_HELD);
  });

  it('drops the least recently used key to make room', async () => {
    const cache = new ProverKeyCache(25);
    const [a, b, c] = [key(10, 1), key(10, 2), key(10, 3)];
    await send(cache, ORIGIN, a, 10);
    await send(cache, ORIGIN, b, 10);
    cache.get(ORIGIN, sha(a));
    await send(cache, ORIGIN, c, 10);

    expect(cache.get(ORIGIN, sha(a))).toEqual(a);
    expect(cache.get(ORIGIN, sha(c))).toEqual(c);
    expect(() => cache.get(ORIGIN, sha(b))).toThrow(PROVER_KEY_NOT_HELD);
    expect(cache.heldBytes).toBe(20);
  });

  it('refuses a key larger than it holds', async () => {
    const cache = new ProverKeyCache(15);
    await expect(send(cache, ORIGIN, key(20), 10)).rejects.toThrow(/larger than the wallet holds/);
  });

  it('fills in a referenced prover key and passes other material through', async () => {
    const cache = new ProverKeyCache();
    const bytes = key(10);
    await send(cache, ORIGIN, bytes, 10);
    const zkir = new Uint8Array([1]);
    const verifierKey = new Uint8Array([2]);

    expect(cache.resolve(ORIGIN, { zkir, verifierKey, proverKeySha256: sha(bytes) })).toEqual({
      zkir,
      verifierKey,
      proverKey: bytes,
    });
    const full = { zkir, verifierKey, proverKey: new Uint8Array([3]) };
    expect(cache.resolve(ORIGIN, full)).toBe(full);
    expect(cache.resolve(ORIGIN, null)).toBeNull();
    expect(() => cache.resolve(ORIGIN, { zkir, verifierKey, proverKeySha256: sha(key(10, 9)) })).toThrow(
      PROVER_KEY_NOT_HELD,
    );
  });
});
