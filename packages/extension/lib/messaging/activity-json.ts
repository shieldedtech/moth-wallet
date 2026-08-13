// Activity (de)serialization — ActivityEntry carries bigints and a Date, so it
// can't cross a JSON message boundary as-is. Same shape and constraints as
// balances-json: extension-API-free (type-only imports), usable from the
// dedicated wallet worker.

import type { ActivityEntry } from '@shieldedtech/moth-browser';

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { __t: 'bigint', v: value.toString() };
  return value;
}

function reviver(key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { __t?: string }).__t === 'bigint') {
    return BigInt((value as { v: string }).v);
  }
  if (key === 'timestamp' && typeof value === 'string') return new Date(value);
  return value;
}

export function serializeActivity(entries: ActivityEntry[]): string {
  return JSON.stringify(entries, replacer);
}

export function deserializeActivity(payload: string): ActivityEntry[] {
  return JSON.parse(payload, reviver) as ActivityEntry[];
}
