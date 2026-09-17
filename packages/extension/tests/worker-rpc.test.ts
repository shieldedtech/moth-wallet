import { describe, it, expect } from 'vitest';
import { serializeHostError, deserializeHostError, jsonSafeError } from '../lib/offscreen/worker-rpc';
import { WalletError } from '@midnightntwrk/wallet-sdk-shielded/v1';
import { HOST_METHODS } from '../lib/offscreen/host-dispatch';

// worker-bridge.ts is deliberately not unit-tested: its `?worker` import doesn't
// resolve under vitest, and it's a thin id-correlation/relay layer covered by
// the manual pass. This file covers the two pieces that carry real logic: the
// error codec and the dispatch-map coverage.

describe('host error codec', () => {
  it('round-trips a plain Error (name/message/stack)', () => {
    const original = new Error('boom');
    const restored = deserializeHostError(serializeHostError(original)) as Error;

    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe('Error');
    expect(restored.message).toBe('boom');
    expect(restored.stack).toBe(original.stack);
  });

  it('preserves a WalletError-shaped error: name, own `category`, and the cause chain', () => {
    const original = new Error('Proof server not reachable at http://localhost:6300', {
      cause: new Error('ECONNREFUSED'),
    }) as Error & { category: string };
    original.name = 'ProofError';
    original.category = 'PROOF_ERROR'; // own enumerable prop, like WalletError

    const restored = deserializeHostError(serializeHostError(original)) as Error & { category?: string };

    expect(restored.name).toBe('ProofError');
    expect(restored.message).toBe('Proof server not reachable at http://localhost:6300');
    // The custom prop a raw structured clone would drop.
    expect(restored.category).toBe('PROOF_ERROR');
    expect(restored.cause).toBeInstanceOf(Error);
    expect((restored.cause as Error).message).toBe('ECONNREFUSED');
  });

  it('passes a thrown string through unchanged', () => {
    expect(deserializeHostError(serializeHostError('nope'))).toBe('nope');
  });

  it('passes a thrown plain object through unchanged', () => {
    const original = { code: 42, detail: 'nope' };
    expect(deserializeHostError(serializeHostError(original))).toEqual(original);
  });

  it('degrades a non-cloneable throw to its String() form', () => {
    const fn = () => 'unused';
    expect(serializeHostError(fn)).toBe(String(fn));
  });
});

describe('HOST_METHODS', () => {
  // Every os/* request method — the OffscreenProtocol surface minus the
  // synchronous ping and the three offscreen → SW events.
  const EXPECTED = [
    'os/walletList',
    'os/walletCreate',
    'os/walletImport',
    'os/walletRemove',
    'os/walletSetActive',
    'os/walletSetLabel',
    'os/walletExportPhrase',
    'os/walletSetNetwork',
    'os/walletUnlock',
    'os/syncEnsure',
    'os/syncStop',
    'os/syncCacheClear',
    'os/syncCacheReset',
    'os/balancesGet',
    'os/sendTokens',
    'os/estimateTransferFee',
    'os/preseedStatus',
    'os/preseedWarm',
    'os/registerDust',
    'os/relayRetry',
    'os/nightCoins',
    'os/requestStats',
    'os/requestStatsReset',
    'os/deregisterDust',
    'os/dustRebuild',
    'os/transferBuild',
    'os/transferSubmit',
    'os/txHistoryGet',
    'os/txSummary',
    'os/activityGet',
    'os/signData',
    'os/deriveAppSecret',
    'os/provingProviderCheck',
    'os/provingProviderProve',
    'os/balanceTransaction',
    'os/makeIntent',
  ];

  it('covers every request method exactly once', () => {
    expect([...HOST_METHODS].sort()).toEqual([...EXPECTED].sort());
  });

  it('excludes the ping and the events', () => {
    for (const excluded of ['os/ping', 'os/eventBalances', 'os/eventSyncMessage', 'os/eventTxStage']) {
      expect(HOST_METHODS).not.toContain(excluded);
    }
  });
});

// The offscreen → service worker hop is JSON. @webext-core serializes an Error
// by spreading its own enumerable props, so one bigint field fails the whole
// reply — and the SDK error a dApp most needs carries `amount` as a bigint.
describe('jsonSafeError', () => {
  /** What @webext-core puts on the wire for an Error. */
  const wire = (err: unknown) => {
    const e = err as Error;
    return { name: e.name, message: e.message, stack: e.stack ?? '', ...(e as object) };
  };

  it("lets the SDK's InsufficientFundsError survive the hop", () => {
    const err = new WalletError.InsufficientFundsError({
      message: 'Insufficient funds for fallible segment 31897',
      tokenType: 'night',
      amount: 31897n,
    });

    // Without it, the reply cannot be serialized at all.
    expect(() => JSON.stringify(wire(err))).toThrow(/BigInt/);

    const safe = jsonSafeError(err) as Error & { tokenType: string; amount: string };
    expect(() => JSON.stringify(wire(safe))).not.toThrow();
    expect(safe).toBeInstanceOf(Error);
    expect(safe.message).toBe('Insufficient funds for fallible segment 31897');
    expect(safe.tokenType).toBe('night');
    expect(safe.amount).toBe('31897'); // decimal string, as every bigint crosses this channel
  });

  it('keeps the name, stack and tag so nothing downstream changes', () => {
    const err = new WalletError.InsufficientFundsError({
      message: 'short',
      tokenType: 'night',
      amount: 1n,
    });
    const safe = jsonSafeError(err) as Error & { _tag: string };
    expect(safe.name).toBe(err.name);
    expect(safe.stack).toBe(err.stack);
    expect(safe._tag).toBe('Wallet.InsufficientFunds');
  });

  it('converts a bigint nested in a field', () => {
    const err = new Error('nested');
    Object.assign(err, { detail: { amounts: [1n, 2n] } });
    expect(() => JSON.stringify(wire(jsonSafeError(err)))).not.toThrow();
  });

  it('converts a bigint on a cause', () => {
    const inner = new Error('inner');
    Object.assign(inner, { amount: 5n });
    const err = new Error('outer', { cause: inner });
    const safe = jsonSafeError(err) as Error & { cause: { amount: string } };
    expect(safe.cause.amount).toBe('5');
    expect(() => JSON.stringify(wire(safe))).not.toThrow();
  });

  it('leaves an error with no bigints alone', () => {
    const err = new Error('plain');
    Object.assign(err, { category: 'WALLET_ERROR' });
    const safe = jsonSafeError(err) as Error & { category: string };
    expect(safe.message).toBe('plain');
    expect(safe.category).toBe('WALLET_ERROR');
  });

  it('passes a non-Error throwable through', () => {
    expect(jsonSafeError('a string')).toBe('a string');
    expect(jsonSafeError(7n)).toBe('7');
  });
});
