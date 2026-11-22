// What the offscreen host records about a transaction it submits, and when it
// tells the panel to re-read the feed. History decides whether a submission is
// pending, applied or rejected; the host's record only supplies the row's detail.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const core = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return {
    entries,
    startWalletSync: vi.fn(),
    buildTransferTransaction: vi.fn(),
    balanceTransaction: vi.fn(),
    summarizeConnectorTransaction: vi.fn(),
    submitFinalizedTransaction: vi.fn(),
    history: vi.fn(),
    adoptTransaction: vi.fn(),
  };
});

vi.mock('@shieldedtech/moth-browser', () => ({
  createMothBrowser: () => ({ wallets: { list: async () => [] } }),
  startWalletSync: core.startWalletSync,
  deriveWalletKeys: (seed: string) => ({ seed }),
  IdbSyncStateStore: class {
    async get(key: string) {
      return core.entries.get(key) ?? null;
    }
    async put(key: string, value: string) {
      core.entries.set(key, value);
    }
    async delete(key: string) {
      core.entries.delete(key);
    }
  },
  EMPTY_COINS: { shielded: [], unshielded: [], dust: [] },
  buildTransferTransaction: core.buildTransferTransaction,
  estimateTransferFee: vi.fn(),
  balanceTransaction: core.balanceTransaction,
  summarizeConnectorTransaction: core.summarizeConnectorTransaction,
  buildSwapIntent: vi.fn(),
  designateForDust: vi.fn(),
  dedesignateFromDust: vi.fn(),
  submitFinalizedTransaction: core.submitFinalizedTransaction,
  transactionHashOf: (tx: { transactionHash(): string }) => tx.transactionHash(),
  activeProtocolVersion: vi.fn(async () => undefined),
  deriveShieldedPublicKeys: vi.fn(),
  clearSyncCache: vi.fn(),
  clearDustSyncCache: vi.fn(),
  clearEmptyRefCache: vi.fn(),
  warmEmptyRefCache: vi.fn(),
  preseedReferenceStatus: vi.fn(),
  DustRegistrationNotYetError: class extends Error {},
  signMessage: vi.fn(),
  deriveAppSecret: vi.fn(),
  deriveActivity: vi.fn(),
  createProvingProvider: vi.fn(),
  ensureProverReady: vi.fn(async () => undefined),
  resolveProverConfig: vi.fn(),
  setWasmProvingProviderFactory: vi.fn(),
  submitWithHealthTracking: (submit: () => Promise<unknown>) => submit(),
  dustSpendHealthTracker: () => ({ recordSuccess: vi.fn() }),
  diagnoseSubmissionFailure: async (_tracker: unknown, error: unknown) => error,
}));

vi.mock('./../lib/offscreen/bundled-preseed', () => ({
  installBundledReference: vi.fn(async () => false),
  hasBundledReference: vi.fn(async () => false),
}));
vi.mock('./../lib/offscreen/relay-socket', () => ({
  setRelayUrl: vi.fn(),
  relayRetry: (fn: unknown) => fn,
}));
vi.mock('@midnightntwrk/ledger-v8', () => ({}));
vi.mock('./../lib/messaging/balances-json', () => ({ serializeBalances: () => '{}' }));

// Warm the module graph at collection time, where no hook timeout applies.
import '../lib/offscreen/wallet-host';
import { loadSubmissions, type SubmittedTx } from '../lib/offscreen/submissions';

const NETWORK = { id: 'preprod', nodeUrl: 'https://rpc.preprod.example', indexerUrl: 'https://ix.example' } as never;
const SEED = 'aa'.repeat(32);
const WALLET = 'alice';
const HASH = 'a'.repeat(64);
const REQUEST = { type: 'unshielded' as const, tokenId: '0'.repeat(64), amount: '120', to: 'mn_addr1recipient' };

function finalizedTx(hash = HASH) {
  return { transactionHash: () => hash, serialize: () => new Uint8Array([0xbb]) };
}

describe('wallet-host submission records', () => {
  let host: typeof import('../lib/offscreen/wallet-host');
  let activityChanges: unknown[];

  const recorded = (): Promise<SubmittedTx[]> =>
    loadSubmissions(
      {
        get: async (key: string) => core.entries.get(key) ?? null,
        put: async () => undefined,
        delete: async () => undefined,
      },
      'preprod',
      WALLET,
    );

  /** The sync option through which core reports history's pending and rejected entries. */
  const historyRecorded = (hash: string) => core.startWalletSync.mock.calls[0]![6].onSubmissionVerdict(hash);

  beforeEach(async () => {
    vi.resetModules();
    core.entries.clear();
    for (const mock of Object.values(core)) if (vi.isMockFunction(mock)) mock.mockReset();
    core.history.mockResolvedValue([]);
    core.adoptTransaction.mockReturnValue(finalizedTx());
    core.startWalletSync.mockResolvedValue({
      facade: { getAllFromTxHistory: core.history, adoptTransaction: core.adoptTransaction },
      balances: { synced: true },
      stop: vi.fn(async () => undefined),
      subscribe: () => () => undefined,
    });
    activityChanges = [];
    host = await import('../lib/offscreen/wallet-host');
    host.setHostEmit((event, data) => {
      if (event === 'os/eventActivityChanged') activityChanges.push(data);
    });
  });

  it('tells the panel when history records a submission as pending or rejected', async () => {
    await host.syncEnsure(SEED, WALLET, NETWORK);

    historyRecorded(HASH);

    expect(activityChanges).toEqual([HASH]);
  });

  describe('sendTokens', () => {
    it('has the record in place before the transaction is sent', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      let atSubmit: SubmittedTx[] = [];
      core.submitFinalizedTransaction.mockImplementation(async () => {
        atSubmit = await recorded();
        return 'facade-id';
      });

      await expect(host.sendTokens(SEED, WALLET, NETWORK, [REQUEST])).resolves.toEqual({ txHash: 'facade-id' });

      expect(atSubmit).toEqual([
        expect.objectContaining({ hash: HASH, transactionHash: HASH, kind: 'send', to: REQUEST.to, amount: '120' }),
      ]);
      expect(await recorded()).toHaveLength(1);
    });

    it('keeps the record of a rejected send history knows about, and rethrows', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransaction.mockRejectedValue(new Error('1010: Invalid Transaction'));
      core.history.mockResolvedValue([{ hash: HASH, lifecycle: { status: 'rejected' } }]);

      await expect(host.sendTokens(SEED, WALLET, NETWORK, [REQUEST])).rejects.toThrow('1010: Invalid Transaction');

      expect(await recorded()).toEqual([expect.objectContaining({ hash: HASH, amount: '120' })]);
    });

    it('drops the record of a send that failed before history recorded it', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransaction.mockRejectedValue(new Error('no relay connection'));

      await expect(host.sendTokens(SEED, WALLET, NETWORK, [REQUEST])).rejects.toThrow('no relay connection');

      expect(await recorded()).toEqual([]);
      expect(activityChanges).toEqual([HASH]);
    });
  });

  describe('connector transactions', () => {
    const DAPP_TX_HEX = '0a';
    const BALANCED_HEX = 'bb';

    beforeEach(() => {
      core.summarizeConnectorTransaction.mockReturnValue({
        spends: [{ kind: 'unshielded', tokenId: REQUEST.tokenId, amount: 100n }],
        receives: [],
        contractActions: 0,
      });
      core.balanceTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransaction.mockResolvedValue('facade-id');
    });

    it('reads what balancing covers off the transaction the dApp supplied', async () => {
      await host.balanceTransaction(SEED, WALLET, NETWORK, DAPP_TX_HEX, true, true);

      expect(core.summarizeConnectorTransaction.mock.calls[0]!.slice(0, 2)).toEqual([new Uint8Array([0x0a]), true]);
      expect(core.summarizeConnectorTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        core.balanceTransaction.mock.invocationCallOrder[0]!,
      );
    });

    it('still balances a transaction it cannot summarize', async () => {
      core.summarizeConnectorTransaction.mockImplementation(() => {
        throw new Error('unreadable');
      });

      await expect(host.balanceTransaction(SEED, WALLET, NETWORK, DAPP_TX_HEX, true, true)).resolves.toEqual({
        txHex: 'bb',
      });
    });

    it('records the prepared detail on submit and uses it only once', async () => {
      await host.balanceTransaction(SEED, WALLET, NETWORK, DAPP_TX_HEX, true, true);

      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);
      expect(await recorded()).toEqual([
        expect.objectContaining({ hash: HASH, kind: 'send', amount: '100', tokenKind: 'unshielded' }),
      ]);

      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);
      const [again] = await recorded();
      expect(again?.hash).toBe(HASH);
      expect(again?.amount).toBeUndefined();
    });

    it('records the recipient of a transfer the wallet built for the dApp', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      await host.transferBuild(SEED, WALLET, NETWORK, [REQUEST], true);

      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);

      expect(await recorded()).toEqual([
        expect.objectContaining({ hash: HASH, to: REQUEST.to, amount: '120', outputs: 1 }),
      ]);
    });

    it('records a bare send for a transaction it never prepared', async () => {
      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);

      const [row] = await recorded();
      expect(row).toMatchObject({ hash: HASH, kind: 'send' });
      expect(row?.amount).toBeUndefined();
    });
  });
});
