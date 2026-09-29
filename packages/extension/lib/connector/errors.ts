// Error shape mandated by the Midnight dApp connector spec: a plain Error
// with type/code/reason fields (deliberately not a class — `instanceof`
// doesn't cross the page boundary).

import type { APIError, ErrorCode } from '@midnight-ntwrk/dapp-connector-api';

export type { APIError, ErrorCode };

export interface SerializedConnectorError {
  code: ErrorCode;
  reason: string;
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
