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
 * Scalar detail carried by an error and its `cause` chain, as `k=v` pairs.
 *
 * Wallet SDK errors say far more in their fields than in their message —
 * `InsufficientFundsError` has `tokenType` and `amount`, i.e. exactly which
 * token is short and by how much. The connector reduces errors to
 * `{code, reason}` where reason is a plain string, so without folding these in
 * a DApp sees "Insufficient funds for fallible segment 31897" and has no way to
 * tell WHICH token was short. That makes an otherwise one-step diagnosis
 * impossible from the page.
 *
 * Scalars only, and a bounded depth, so nothing large or circular is copied and
 * no object graph leaks to the page.
 */
export function describeErrorFields(err: unknown, depth = 0): string {
  if (!err || typeof err !== 'object' || depth > 3) return '';
  const SKIP = new Set(['message', 'stack', 'name', 'code', 'reason', 'type', 'cause']);
  const parts: string[] = [];
  for (const key of Object.getOwnPropertyNames(err)) {
    if (SKIP.has(key)) continue;
    const value = (err as Record<string, unknown>)[key];
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      parts.push(`${key}=${String(value)}`);
    }
  }
  const nested = describeErrorFields((err as { cause?: unknown }).cause, depth + 1);
  if (nested) parts.push(nested);
  return parts.join(', ');
}
