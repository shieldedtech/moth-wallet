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
