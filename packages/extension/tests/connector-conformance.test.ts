// What the connector promises a dApp before any request is made: the error
// shape the spec mandates, the method list it implements, and the API version it
// claims. A dApp written against @midnight-ntwrk/dapp-connector-api relies on
// all three, and none of them can be checked from the page without a wallet.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { connectorError } from '../lib/connector/errors';
import { API_VERSION, IMPLEMENTED_METHODS } from '../lib/connector/constants';

describe('connector error shape', () => {
  // The spec's APIError is a plain Error with `type`, `code` and `reason`. dApps
  // detect it by `type`, because `instanceof` does not cross the page boundary.
  it('builds a spec APIError', () => {
    const err = connectorError('PermissionRejected', 'why it failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.type).toBe('DAppConnectorAPIError');
    expect(err.code).toBe('PermissionRejected');
    expect(err.reason).toBe('why it failed');
    expect(err.message).toBe('why it failed');
  });
});

describe('announced connector surface', () => {
  // Keyed by every ConnectedAPI method, so `compile` fails when the spec adds a
  // method this list does not name.
  const SPEC_METHODS: Record<keyof ConnectedAPI, true> = {
    getShieldedBalances: true,
    getUnshieldedBalances: true,
    getDustBalance: true,
    getShieldedAddresses: true,
    getUnshieldedAddress: true,
    getDustAddress: true,
    getTxHistory: true,
    balanceUnsealedTransaction: true,
    balanceSealedTransaction: true,
    makeTransfer: true,
    makeIntent: true,
    signData: true,
    submitTransaction: true,
    getProvingProvider: true,
    getConfiguration: true,
    getConnectionStatus: true,
    hintUsage: true,
  };

  it('implements every ConnectedAPI method and nothing outside it', () => {
    expect([...IMPLEMENTED_METHODS].sort()).toEqual(Object.keys(SPEC_METHODS).sort());
  });

  // dApps read `apiVersion` to decide which calls are safe. A dependency bump
  // that leaves the constant behind would announce a version the wallet does
  // not implement.
  it('announces the installed dapp-connector-api version', () => {
    const entry = fileURLToPath(import.meta.resolve('@midnight-ntwrk/dapp-connector-api'));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe('@midnight-ntwrk/dapp-connector-api');
    expect(API_VERSION).toBe(pkg.version);
  });
});
