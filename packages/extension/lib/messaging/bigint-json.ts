// JSON encoding that survives bigints. Used on both sides of the page ↔
// extension boundary, where structured clone is unavailable (runtime
// messaging is JSON-based) but connector payloads carry bigint amounts and
// the proving-provider proxy carries binary preimages/keys.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBigintJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v === undefined) return { __t: 'undefined' };
    if (typeof v === 'bigint') return { __t: 'bigint', v: v.toString() };
    if (v instanceof Uint8Array) return { __t: 'bytes', v: bytesToBase64(v) };
    return v;
  });
}

export function decodeBigintJson<T = unknown>(payload: string): T {
  const parsed = JSON.parse(payload, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { __t?: string }).__t === 'bigint') {
      return BigInt((v as { v: string }).v);
    }
    if (v && typeof v === 'object' && (v as { __t?: string }).__t === 'bytes') {
      return base64ToBytes((v as { v: string }).v);
    }
    return v;
  });

  const restoreUndefined = (value: unknown): unknown => {
    if (value && typeof value === 'object' && (value as { __t?: string }).__t === 'undefined') {
      return undefined;
    }
    // Binary key material can be large; it is already fully restored by the
    // JSON reviver and must not be walked byte-by-byte here.
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(restoreUndefined);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        (value as Record<string, unknown>)[key] = restoreUndefined(child);
      }
    }
    return value;
  };

  return restoreUndefined(parsed) as T;
}
