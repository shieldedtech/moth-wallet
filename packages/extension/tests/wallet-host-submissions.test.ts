// What the offscreen host records about a transaction it submits: a rejected
// send or DUST operation as a failed row, a landed one as confirmed, and for a
// connector transaction the detail learned when it was balanced.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const core = vi.hoisted(() => {
  const entries = new Map<string, string>();
  return {
    entries,
    startWalletSync: vi.fn(),
    buildTransferTransaction: vi.fn(),
    balanceTransaction: vi.fn(),
    summarizeConnectorTransaction: vi.fn(),
    designateForDust: vi.fn(),
    dedesignateFromDust: vi.fn(),
    submitFinalizedTransactionWithReceipt: vi.fn(),
    rejectedTransactionHash: vi.fn(),
    deserialize: vi.fn(),
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
  designateForDust: core.designateForDust,
  dedesignateFromDust: core.dedesignateFromDust,
  submitFinalizedTransactionWithReceipt: core.submitFinalizedTransactionWithReceipt,
  rejectedTransactionHash: core.rejectedTransactionHash,
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
vi.mock('@midnight-ntwrk/ledger-v8', () => ({ Transaction: { deserialize: core.deserialize } }));
vi.mock('./../lib/messaging/balances-json', () => ({ serializeBalances: () => '{}' }));

// Warm the module graph at collection time, where no hook timeout applies.
import '../lib/offscreen/wallet-host';
import { loadSubmissions, type SubmittedTx } from '../lib/offscreen/submissions';

const NETWORK = { id: 'preprod', nodeUrl: 'https://rpc.preprod.example', indexerUrl: 'https://ix.example' } as never;
const SEED = 'aa'.repeat(32);
const WALLET = 'alice';
const HASH = 'a'.repeat(64);
const TTL = Date.parse('2026-07-13T13:00:00Z');
const REQUEST = { type: 'unshielded' as const, tokenId: '0'.repeat(64), amount: '120', to: 'mn_addr1recipient' };

function finalizedTx(hash = HASH) {
  return {
    transactionHash: () => hash,
    serialize: () => new Uint8Array([0xbb]),
    intents: new Map([[1, { ttl: new Date(TTL) }]]),
  };
}

describe('wallet-host submission records', () => {
  let host: typeof import('../lib/offscreen/wallet-host');
  let activityChanges: unknown[];

  const recorded = (): Promise<SubmittedTx[]> =>
    loadSubmissions(new (class {
      get = async (key: string) => core.entries.get(key) ?? null;
      put = async () => undefined;
      delete = async () => undefined;
    })(), 'preprod', WALLET);

  /** The sync option through which core reports the SDK tracker's verdicts. */
  const reportOutcome = (outcome: { transactionHash: string; identifiers: string[]; status: 'FAILURE' }) =>
    core.startWalletSync.mock.calls[0]![6].onTransactionOutcome(outcome);

  beforeEach(async () => {
    vi.resetModules();
    core.entries.clear();
    for (const mock of Object.values(core)) if (vi.isMockFunction(mock)) mock.mockReset();
    core.startWalletSync.mockResolvedValue({
      facade: {},
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

  describe('sendTokens', () => {
    it('records a rejected send as a failed row and rethrows the rejection', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransactionWithReceipt.mockRejectedValue(new Error('1010: Invalid Transaction'));

      await expect(host.sendTokens(SEED, WALLET, NETWORK, [REQUEST])).rejects.toThrow('1010: Invalid Transaction');

      const [row] = await recorded();
      expect(row).toMatchObject({ hash: HASH, kind: 'send', to: REQUEST.to, amount: '120' });
      expect(row?.failure).toBeDefined();
      expect(row?.confirmed).toBeUndefined();
      expect(activityChanges).toEqual([HASH]);
    });

    it('records a landed send as confirmed, with its intent deadline', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransactionWithReceipt.mockResolvedValue({ txHash: HASH, included: true });

      await expect(host.sendTokens(SEED, WALLET, NETWORK, [REQUEST])).resolves.toEqual({ txHash: HASH });

      const [row] = await recorded();
      expect(row).toMatchObject({ hash: HASH, confirmed: true, expiresAt: TTL });
      expect(row?.failure).toBeUndefined();
    });

    it('leaves a send that was only already in the pool unconfirmed', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      core.submitFinalizedTransactionWithReceipt.mockResolvedValue({ txHash: HASH, included: false });

      await host.sendTokens(SEED, WALLET, NETWORK, [REQUEST]);

      expect((await recorded())[0]?.confirmed).toBe(false);
    });

    it('applies a failure verdict that arrived before the submission was recorded', async () => {
      core.buildTransferTransaction.mockResolvedValue(finalizedTx());
      let land!: (receipt: { txHash: string; included: boolean }) => void;
      core.submitFinalizedTransactionWithReceipt.mockReturnValue(new Promise((resolve) => { land = resolve; }));

      const sending = host.sendTokens(SEED, WALLET, NETWORK, [REQUEST]);
      await vi.waitFor(() => expect(core.submitFinalizedTransactionWithReceipt).toHaveBeenCalled());
      reportOutcome({ transactionHash: HASH, identifiers: [], status: 'FAILURE' });
      land({ txHash: HASH, included: true });
      await sending;

      expect((await recorded())[0]?.failure).toBeDefined();
    });
  });

  describe.each([
    ['registerDust', 'designateForDust', 3],
    ['deregisterDust', 'dedesignateFromDust', 2],
  ] as const)('%s', (method, coreOp, stageArg) => {
    const failAt = (stage: string, error: Error) =>
      core[coreOp].mockImplementation(async (...args: unknown[]) => {
        const stages = stage === 'submitting' ? ['proving', 'submitting'] : [stage];
        for (const reached of stages) (args[stageArg + 1] as (s: string) => void)(reached);
        throw error;
      });

    it('records nothing for a failure before the submitting stage', async () => {
      failAt('proving', new Error('proof server unreachable'));

      await expect(host[method](SEED, WALLET, NETWORK)).rejects.toThrow('proof server unreachable');

      expect(await recorded()).toEqual([]);
      expect(activityChanges).toEqual([]);
    });

    it('records a rejection at the submitting stage under the transaction hash', async () => {
      const rejection = new Error('1010: Invalid Transaction');
      failAt('submitting', rejection);
      core.rejectedTransactionHash.mockImplementation((error) => (error === rejection ? HASH : undefined));

      await expect(host[method](SEED, WALLET, NETWORK)).rejects.toThrow('1010: Invalid Transaction');

      const [row] = await recorded();
      expect(row).toMatchObject({ hash: HASH, transactionHash: HASH, kind: 'dust' });
      expect(row?.failure).toBeDefined();
    });

    it('falls back to a local identity when the rejection carries no hash', async () => {
      failAt('submitting', new Error('1010: Invalid Transaction'));

      await expect(host[method](SEED, WALLET, NETWORK)).rejects.toThrow();

      expect((await recorded())[0]?.hash).toMatch(/^local:/);
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
      core.deserialize.mockReturnValue(finalizedTx());
      core.submitFinalizedTransactionWithReceipt.mockResolvedValue({ txHash: HASH, included: true });
    });

    it('reads what balancing covers off the transaction the dApp supplied', async () => {
      await host.balanceTransaction(SEED, WALLET, NETWORK, DAPP_TX_HEX, true, true);

      expect(core.summarizeConnectorTransaction).toHaveBeenCalledWith(new Uint8Array([0x0a]), true);
      expect(core.summarizeConnectorTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        core.balanceTransaction.mock.invocationCallOrder[0]!,
      );
    });

    it('records the prepared detail on submit and uses it only once', async () => {
      await host.balanceTransaction(SEED, WALLET, NETWORK, DAPP_TX_HEX, true, true);

      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);
      expect(await recorded()).toEqual([
        expect.objectContaining({ hash: HASH, amount: '100', tokenKind: 'unshielded', confirmed: true, expiresAt: TTL }),
      ]);

      await host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX);
      const [again] = await recorded();
      expect(again?.hash).toBe(HASH);
      expect(again?.amount).toBeUndefined();
    });

    it('records a rejected connector submission as failed and rethrows', async () => {
      core.submitFinalizedTransactionWithReceipt.mockRejectedValue(new Error('1010: Invalid Transaction'));

      await expect(host.transferSubmit(SEED, WALLET, NETWORK, BALANCED_HEX)).rejects.toThrow('1010');

      expect((await recorded())[0]?.failure).toBeDefined();
    });
  });
});
