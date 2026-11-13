// Error shape mandated by the Midnight dApp connector spec: a plain Error
// with type/code/reason fields (deliberately not a class — `instanceof`
// doesn't cross the page boundary).

import type { APIError, ErrorCode } from '@midnight-ntwrk/dapp-connector-api';

export type { APIError, ErrorCode };

/**
 * A CIP-30 error, in the shape the spec requires a Cardano dApp to catch.
 *
 * Deliberately NOT the Midnight connector's `{code: string, reason}`: CIP-30
 * fixes numeric codes that dApps switch on, and `PaginateError` carries only
 * `maxSize` with no code at all.
 */
export type Cip30Wire =
  | { readonly code: number; readonly info: string }
  | { readonly maxSize: number };

export interface SerializedConnectorError {
  code: ErrorCode;
  reason: string;
  /**
   * Set when the failure came from the CIP-30 surface. The Midnight `code` and
   * `reason` beside it are then only for logging — the Cardano provider rebuilds
   * the error from this and throws that instead.
   */
  cip30?: Cip30Wire;
}

/**
 * Recognise a CIP-30 error thrown by the Cardano layer.
 *
 * These are thrown as plain objects, not Errors, so the generic catch below
 * would otherwise reduce one to `String(err)` — literally "[object Object]" —
 * and drop `info` and `maxSize` on the floor.
 */
export function asCip30Error(err: unknown): Cip30Wire | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.maxSize === 'number') return { maxSize: e.maxSize };
  if (typeof e.code === 'number' && typeof e.info === 'string') {
    return { code: e.code, info: e.info };
  }
  return undefined;
}

/**
 * The CIP-30 error codes the connector itself raises.
 *
 * Mirrored here rather than imported from core because this file is reachable
 * from the background service worker, and core's Cardano module pulls in CML's
 * WASM — which an IIFE bundle cannot load, having no top-level await. The
 * mirror is pinned to core by tests/cip30-error-codes.test.ts, so drift is a
 * test failure rather than a wrong number on the wire.
 */
export const CIP30_CODES = {
  /** APIError.Refused — the origin is not authorized. */
  apiRefused: -3,
  /** TxSignError.UserDeclined */
  txSignUserDeclined: 2,
  /** DataSignError.UserDeclined */
  dataSignUserDeclined: 3,
  /** TxSendError.Refused */
  txSendRefused: 1,
} as const;

/** A human-readable line for a CIP-30 error, for the connector's own logging. */
export function describeCip30Error(wire: Cip30Wire): string {
  return 'maxSize' in wire
    ? `Paginate request out of range; maxSize: ${wire.maxSize}`
    : `${wire.info} (CIP-30 code ${wire.code})`;
}

export function connectorError(code: ErrorCode, reason: string): APIError {
  const error = new Error(reason) as APIError;
  error.type = 'DAppConnectorAPIError';
  error.code = code;
  error.reason = reason;
  return error;
}

export function serializeError(code: ErrorCode, reason: string): SerializedConnectorError {
  return { code, reason };
}

/**
 * Fields a dApp is allowed to see, by name.
 *
 * An allowlist, not a denylist, because this crosses into an untrusted page: a
 * field is exposed only once someone has decided it should be. The denylist
 * this replaced forwarded every scalar own property, which on a probe meant a
 * cause's `url` (credentials and query string included), its `status` and its
 * response `body`, and would have carried the `originalStack` that
 * core/contract/deploy.ts attaches to a failed deploy.
 */
const EXPOSED_FIELDS = ['tokenType', 'amount'] as const;

/** Per-value and total caps. A field is diagnostic detail, not a payload; the
 *  200 KB `responseText` the previous version copied whole was neither. */
const MAX_VALUE_CHARS = 128;
const MAX_TOTAL_CHARS = 512;

/**
 * Allowlisted detail carried by an error and its `cause` chain, as `k=v` pairs.
 *
 * Wallet SDK errors say more in their fields than in their message —
 * `InsufficientFundsError` has `tokenType` and `amount`, i.e. exactly which
 * token is short and by how much. The connector reduces errors to
 * `{code, reason}` where reason is a plain string, so without folding these in
 * a dApp sees "Insufficient funds for fallible segment 31897" and cannot tell
 * WHICH token was short — the contract's or the fee token, which need
 * different fixes.
 *
 * Only `cause` values that are themselves Errors are followed. The previous
 * version walked plain objects too, which is how an HTTP context hung off a
 * cause reached the page.
 */
export function describeErrorFields(err: unknown, depth = 0): string {
  if (!(err instanceof Error) || depth > 3) return '';
  const parts: string[] = [];
  for (const key of EXPOSED_FIELDS) {
    const value = (err as unknown as Record<string, unknown>)[key];
    const kind = typeof value;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean' && kind !== 'bigint') continue;
    // bigint has no JSON form; String() is what the reason line wants anyway.
    const text = String(value);
    parts.push(`${key}=${text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text}`);
  }
  const nested = describeErrorFields(err.cause, depth + 1);
  if (nested) parts.push(nested);
  const joined = parts.join(', ');
  return joined.length > MAX_TOTAL_CHARS ? `${joined.slice(0, MAX_TOTAL_CHARS)}…` : joined;
}
