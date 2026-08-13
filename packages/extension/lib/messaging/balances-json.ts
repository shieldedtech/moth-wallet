// Balances (de)serialization — WalletBalances is full of bigints and Dates, so
// it can't cross a structured-clone or JSON boundary as-is.
//
// IMPORTANT: this module must stay extension-API-free (only a `WalletBalances`
// type import). It is imported by the dedicated wallet worker, where a static
// `webextension-polyfill` import (pulled in by @webext-core/messaging) throws at
// module evaluation. Keeping it separate from `protocol.ts` lets the worker use
// it without dragging the messaging stack in.

import type { WalletBalances } from '@shieldedtech/moth-browser';

const DATE_KEYS = new Set(['fillTime', 'maxCapReachedAt', 'dtime', 'newestRegisteredAt']);

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return { __t: 'bigint', v: value.toString() };
  return value;
}

function reviver(key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { __t?: string }).__t === 'bigint') {
    return BigInt((value as { v: string }).v);
  }
  if (DATE_KEYS.has(key) && typeof value === 'string') return new Date(value);
  return value;
}

export function serializeBalances(balances: WalletBalances): string {
  return JSON.stringify(balances, replacer);
}

export function deserializeBalances(payload: string): WalletBalances {
  return JSON.parse(payload, reviver) as WalletBalances;
}
