import { describe, it, expect } from 'vitest';
import { serializeHostError, deserializeHostError } from '../lib/offscreen/worker-rpc';
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
