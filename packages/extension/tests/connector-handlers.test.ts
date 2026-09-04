import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { DEFAULT_NETWORKS, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';

// Wallet/ledger work is delegated to the offscreen document — mock that surface
// so these tests exercise the connector's gating/dispatch logic, not WASM.
const balancesGet = vi.fn<() => Promise<string>>();
const transferBuild = vi.fn();
const transferSubmit = vi.fn();
const txHistoryGet = vi.fn();
const signData = vi.fn();
const balanceTransaction = vi.fn();
const txSummary = vi.fn();
const makeIntent = vi.fn();
const provingProviderCheck = vi.fn();
const provingProviderProve = vi.fn();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    balancesGet: (...a: unknown[]) => balancesGet(...(a as [])),
    transferBuild: (...a: unknown[]) => transferBuild(...(a as [])),
    transferSubmit: (...a: unknown[]) => transferSubmit(...(a as [])),
    txHistoryGet: (...a: unknown[]) => txHistoryGet(...(a as [])),
    signData: (...a: unknown[]) => signData(...(a as [])),
    balanceTransaction: (...a: unknown[]) => balanceTransaction(...(a as [])),
    txSummary: (...a: unknown[]) => txSummary(...(a as [])),
    makeIntent: (...a: unknown[]) => makeIntent(...(a as [])),
    provingProviderCheck: (...a: unknown[]) => provingProviderCheck(...(a as [])),
    provingProviderProve: (...a: unknown[]) => provingProviderProve(...(a as [])),
  },
}));

const requestApproval = vi.fn<() => Promise<boolean>>();
const preparedPanel = Promise.resolve(true);
const prepareApprovalPanel = vi.fn<(tabId?: number) => Promise<boolean>>(() => preparedPanel);
vi.mock('../lib/background/approvals', () => ({
  requestApproval: (...a: unknown[]) => requestApproval(...(a as [])),
  prepareApprovalPanel: (tabId?: number) => prepareApprovalPanel(tabId),
  getApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  resolveApproval: vi.fn(),
  hasPendingApproval: vi.fn(() => false),
}));

// beginOp/endOp only bracket in-flight ops (keepalive + idle teardown); stub
// them so these dispatch tests don't drive the real sync engine or schedule a
// teardown timer. Kept referenceable to assert dispatch brackets every request.
const beginOp = vi.fn();
const endOp = vi.fn();
vi.mock('../lib/background/sync-service', () => ({
  beginOp: () => beginOp(),
  endOp: () => endOp(),
}));

import { dispatch } from '../lib/background/connector-handlers';
import { grant, isAllowed } from '../lib/background/permissions';
import { saveSession, type Session } from '../lib/background/session';
import { updateSettings } from '../lib/background/settings';
import { serializeBalances } from '../lib/messaging/protocol';

const ORIGIN = 'https://dapp.example';

const SESSION: Session = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  address: 'mn_unshield_devnet',
  addresses: {
    zswap: { hex: '', bech32m: { devnet: 'mn_shield_devnet' } },
    nightExternal: { hex: '', bech32m: { devnet: 'mn_unshield_devnet' } },
    dust: { hex: '', bech32m: { devnet: 'mn_dust_devnet' } },
  } as unknown as Session['addresses'],
  shieldedCoinPublicKey: 'c0'.repeat(16),
  shieldedEncryptionPublicKey: 'e0'.repeat(16),
  network: 'devnet',
  unlockedAt: 1,
};

function sampleBalances(): WalletBalances {
  return {
    shielded: { ['0'.repeat(64)]: 500n },
    unshielded: { ['0'.repeat(64)]: 42n },
    dust: 999n,
    dustGeneration: { limit: 5_000n } as WalletBalances['dustGeneration'],
    synced: true,
  } as unknown as WalletBalances;
}

/** What the offscreen summary reports for a dApp tx one NIGHT short. */
const NIGHT_SPEND = {
  spends: [{ kind: 'unshielded', tokenId: '0'.repeat(64), amount: '1000000' }],
  receives: [],
  contractActions: 0,
};

async function connect() {
  await grant(ORIGIN, 'devnet');
  await saveSession(SESSION);
}

describe('connector dispatch', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    balancesGet.mockReset();
    transferBuild.mockReset();
    transferSubmit.mockReset();
    txHistoryGet.mockReset();
    signData.mockReset();
    balanceTransaction.mockReset();
    txSummary.mockReset();
    makeIntent.mockReset();
    provingProviderCheck.mockReset();
    provingProviderProve.mockReset();
    requestApproval.mockReset();
    prepareApprovalPanel.mockClear();
    beginOp.mockReset();
    endOp.mockReset();
    // Pin the wallet's network so these tests don't depend on DEFAULT_SETTINGS
    // (which defaults to mainnet); the fixtures below are keyed to devnet.
    await updateSettings({ network: 'devnet' });
  });

  it('allows mainnet (the default network)', async () => {
    await updateSettings({ network: 'mainnet' });
    await grant(ORIGIN, 'mainnet');
    await saveSession({ ...SESSION, network: 'mainnet' });
    expect(await dispatch(ORIGIN, 'connect', ['mainnet'])).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects a network mismatch', async () => {
    await expect(dispatch(ORIGIN, 'connect', ['preview'])).rejects.toMatchObject({ code: 'InvalidRequest' });
  });

  it('authorizes the standard proving-provider handshake', async () => {
    await connect();
    await expect(dispatch(ORIGIN, 'getProvingProvider', [])).resolves.toBe(true);
  });

  it('rejects an unknown method as InvalidRequest', async () => {
    await expect(dispatch(ORIGIN, 'bogus' as never, [])).rejects.toMatchObject({ code: 'InvalidRequest' });
  });

  it('hintUsage prompts for approval when not yet connected, then grants', async () => {
    await saveSession(SESSION); // unlocked but not granted
    requestApproval.mockResolvedValue(true);

    await expect(dispatch(ORIGIN, 'hintUsage', [['getShieldedBalances']])).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(await isAllowed(ORIGIN)).toBe(true);
  });

  it('hintUsage skips the prompt when already connected', async () => {
    await connect();
    await expect(dispatch(ORIGIN, 'hintUsage', [['getShieldedBalances']])).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('hintUsage rejects when the user declines approval', async () => {
    await saveSession(SESSION);
    requestApproval.mockResolvedValue(false);
    await expect(dispatch(ORIGIN, 'hintUsage', [['getShieldedBalances']])).rejects.toMatchObject({ code: 'Rejected' });
    expect(await isAllowed(ORIGIN)).toBe(false);
  });

  it('gates data methods on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(dispatch(ORIGIN, 'getShieldedBalances', [])).rejects.toMatchObject({ code: 'PermissionRejected' });
  });

  it('reports connection status', async () => {
    expect(await dispatch(ORIGIN, 'getConnectionStatus', [])).toEqual({ status: 'disconnected' });
    await connect();
    expect(await dispatch(ORIGIN, 'getConnectionStatus', [])).toEqual({ status: 'connected', networkId: 'devnet' });
  });

  it('returns the proof-server configuration once connected', async () => {
    await connect();
    const config = (await dispatch(ORIGIN, 'getConfiguration', [])) as {
      networkId: string;
      indexerWsUri: string;
      proverServerUri?: string;
    };
    expect(config.networkId).toBe('devnet');
    expect(config.indexerWsUri).toMatch(/^wss?:\/\//);
    const prover = resolveProverConfig(DEFAULT_NETWORKS.devnet!);
    expect(config.proverServerUri).toBe(prover.type === 'server' ? prover.url : undefined);
  });

  it('omits the deprecated proof-server URI when WASM proving is selected', async () => {
    await connect();
    await updateSettings({
      customEndpoints: {
        nodeUrl: DEFAULT_NETWORKS.devnet!.nodeUrl,
        indexerUrl: DEFAULT_NETWORKS.devnet!.indexerUrl,
        prover: {type: 'wasm'},
      },
    });

    await expect(dispatch(ORIGIN, 'getConfiguration', [])).resolves.not.toHaveProperty('proverServerUri');
  });

  it('forwards low-level proving-provider operations to the selected wallet prover', async () => {
    await connect();
    const serializedPreimage = new Uint8Array([1, 2, 3]);
    const keyMaterial = {
      zkir: new Uint8Array([4]),
      proverKey: new Uint8Array([5]),
      verifierKey: new Uint8Array([6]),
    };
    provingProviderCheck.mockResolvedValue([7n, undefined]);
    provingProviderProve.mockResolvedValue(new Uint8Array([8, 9]));

    await expect(
      dispatch(ORIGIN, 'provingProviderCheck', [serializedPreimage, 'counter.increment', keyMaterial]),
    ).resolves.toEqual([7n, undefined]);
    expect(provingProviderCheck).toHaveBeenCalledWith(expect.objectContaining({
      serializedPreimage,
      keyLocation: 'counter.increment',
      keyMaterial,
      network: expect.objectContaining({prover: expect.objectContaining({type: 'server'})}),
    }));

    await expect(
      dispatch(ORIGIN, 'provingProviderProve', [serializedPreimage, 'counter.increment', keyMaterial, 42n]),
    ).resolves.toEqual(new Uint8Array([8, 9]));
    expect(provingProviderProve).toHaveBeenCalledWith(expect.objectContaining({overwriteBindingInput: 42n}));
  });

  it('exposes the shielded public keys from the session', async () => {
    await connect();
    const res = (await dispatch(ORIGIN, 'getShieldedAddresses', [])) as {
      shieldedAddress: string;
      shieldedCoinPublicKey: string;
      shieldedEncryptionPublicKey: string;
    };
    expect(res.shieldedAddress).toBe('mn_shield_devnet');
    expect(res.shieldedCoinPublicKey).toBe(SESSION.shieldedCoinPublicKey);
    expect(res.shieldedEncryptionPublicKey).toBe(SESSION.shieldedEncryptionPublicKey);
  });

  it('connect prompts for approval when not yet allowed, then grants', async () => {
    await saveSession(SESSION);
    requestApproval.mockResolvedValue(true);

    const connection = dispatch(ORIGIN, 'connect', ['devnet']);
    expect(prepareApprovalPanel).toHaveBeenCalledWith(undefined);
    expect(await connection).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(await isAllowed(ORIGIN)).toBe(true);
  });

  it('connect skips the prompt when already allowed and unlocked', async () => {
    await connect();
    expect(await dispatch(ORIGIN, 'connect', ['devnet'])).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects connect when the user declines approval', async () => {
    await saveSession(SESSION);
    requestApproval.mockResolvedValue(false);
    await expect(dispatch(ORIGIN, 'connect', ['devnet'])).rejects.toMatchObject({ code: 'Rejected' });
    expect(await isAllowed(ORIGIN)).toBe(false);
  });

  it('returns shielded balances from the offscreen snapshot', async () => {
    await connect();
    balancesGet.mockResolvedValue(serializeBalances(sampleBalances()));
    const shielded = (await dispatch(ORIGIN, 'getShieldedBalances', [])) as Record<string, bigint>;
    expect(shielded['0'.repeat(64)]).toBe(500n);
  });

  it('coalesces concurrent balance methods into one offscreen snapshot', async () => {
    await connect();
    let resolveSnapshot!: (value: string) => void;
    balancesGet.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const reads = Promise.all([
      dispatch(ORIGIN, 'getShieldedBalances', []),
      dispatch(ORIGIN, 'getUnshieldedBalances', []),
      dispatch(ORIGIN, 'getDustBalance', []),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(balancesGet).toHaveBeenCalledTimes(1);

    resolveSnapshot(serializeBalances(sampleBalances()));
    await expect(reads).resolves.toEqual([
      { ['0'.repeat(64)]: 500n },
      { ['0'.repeat(64)]: 42n },
      { cap: 5_000n, balance: 999n },
    ]);
    expect(balancesGet).toHaveBeenCalledTimes(1);
  });

  it('returns paginated tx history once connected', async () => {
    await connect();
    const entries = [{ txHash: 'aa', txStatus: { status: 'finalized', executionStatus: { 0: 'Success' } } }];
    txHistoryGet.mockResolvedValue(entries);
    const res = await dispatch(ORIGIN, 'getTxHistory', [0, 10]);
    expect(res).toEqual(entries);
    expect(txHistoryGet).toHaveBeenCalledWith(
      expect.objectContaining({ pageNumber: 0, pageSize: 10, walletName: 'alice' }),
    );
  });

  it('rejects getTxHistory with invalid paging as InvalidRequest', async () => {
    await connect();
    await expect(dispatch(ORIGIN, 'getTxHistory', [0, 0])).rejects.toMatchObject({ code: 'InvalidRequest' });
    expect(txHistoryGet).not.toHaveBeenCalled();
  });

  it('gates getTxHistory on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(dispatch(ORIGIN, 'getTxHistory', [0, 10])).rejects.toMatchObject({ code: 'PermissionRejected' });
  });

  it('signs data after approval', async () => {
    await connect();
    requestApproval.mockResolvedValue(true);
    const signed = { data: 'hi', signature: 'ab', verifyingKey: 'cd' };
    signData.mockResolvedValue(signed);
    const res = await dispatch(ORIGIN, 'signData', ['hi', { encoding: 'text', keyType: 'unshielded' }]);
    expect(res).toEqual(signed);
    expect(requestApproval).toHaveBeenCalledWith(
      'signData',
      ORIGIN,
      { encoding: 'text', message: 'hi' },
      undefined,
      preparedPanel,
    );
    expect(signData).toHaveBeenCalledWith(expect.objectContaining({ data: 'hi', encoding: 'text' }));
  });

  it('rejects signData when the user declines', async () => {
    await connect();
    requestApproval.mockResolvedValue(false);
    await expect(
      dispatch(ORIGIN, 'signData', ['hi', { encoding: 'text', keyType: 'unshielded' }]),
    ).rejects.toMatchObject({ code: 'Rejected' });
    expect(signData).not.toHaveBeenCalled();
  });

  it('rejects signData with an unsupported keyType or encoding before prompting', async () => {
    await connect();
    await expect(
      dispatch(ORIGIN, 'signData', ['hi', { encoding: 'text', keyType: 'shielded' }]),
    ).rejects.toMatchObject({ code: 'InvalidRequest' });
    await expect(
      dispatch(ORIGIN, 'signData', ['hi', { encoding: 'utf7', keyType: 'unshielded' }]),
    ).rejects.toMatchObject({ code: 'InvalidRequest' });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(signData).not.toHaveBeenCalled();
  });

  it('maps a malformed-data signing failure to InvalidRequest', async () => {
    await connect();
    requestApproval.mockResolvedValue(true);
    signData.mockRejectedValue(new Error('Invalid hex data'));
    await expect(
      dispatch(ORIGIN, 'signData', ['zz', { encoding: 'hex', keyType: 'unshielded' }]),
    ).rejects.toMatchObject({ code: 'InvalidRequest', reason: 'Invalid hex data' });
  });

  it('gates signData on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(
      dispatch(ORIGIN, 'signData', ['hi', { encoding: 'text', keyType: 'unshielded' }]),
    ).rejects.toMatchObject({ code: 'PermissionRejected' });
  });

  it('balances a sealed transaction after approval', async () => {
    await connect();
    requestApproval.mockResolvedValue(true);
    txSummary.mockResolvedValue(NIGHT_SPEND);
    balanceTransaction.mockResolvedValue({ txHex: 'beef' });
    const res = await dispatch(ORIGIN, 'balanceSealedTransaction', ['abcd']);
    expect(res).toEqual({ tx: 'beef' });
    expect(requestApproval).toHaveBeenCalledWith(
      'balance',
      ORIGIN,
      { sealed: true, summary: NIGHT_SPEND },
      undefined,
      preparedPanel,
    );
    expect(balanceTransaction).toHaveBeenCalledWith(expect.objectContaining({ txHex: 'abcd', sealed: true }));
  });

  // The user is authorizing a spend, so what the transaction takes from the
  // wallet is read off the transaction and shown BEFORE the prompt — not after
  // balancing, when the funds are already committed.
  it('summarizes the transaction before asking for approval, at the requested stage', async () => {
    await connect();
    const order: string[] = [];
    txSummary.mockImplementation(async () => {
      order.push('summary');
      return NIGHT_SPEND;
    });
    requestApproval.mockImplementation(async () => {
      order.push('approval');
      return true;
    });
    balanceTransaction.mockResolvedValue({ txHex: 'beef' });

    await dispatch(ORIGIN, 'balanceUnsealedTransaction', ['abcd']);
    expect(order).toEqual(['summary', 'approval']);
    expect(txSummary).toHaveBeenCalledWith(expect.objectContaining({ txHex: 'abcd', sealed: false }));
  });

  // A transaction the ledger will not decode is still surfaced — with the summary
  // absent, which the screen renders as an explicit warning — rather than the
  // request failing before the user ever sees it.
  it('still prompts when the transaction cannot be summarized, marking the summary unknown', async () => {
    await connect();
    txSummary.mockRejectedValue(new Error('unexpected end of input'));
    requestApproval.mockResolvedValue(true);
    balanceTransaction.mockResolvedValue({ txHex: 'beef' });

    const res = await dispatch(ORIGIN, 'balanceSealedTransaction', ['abcd']);
    expect(res).toEqual({ tx: 'beef' });
    expect(requestApproval).toHaveBeenCalledWith(
      'balance',
      ORIGIN,
      { sealed: true, summary: null },
      undefined,
      preparedPanel,
    );
  });

  it('rejects balanceSealedTransaction when the user declines', async () => {
    await connect();
    requestApproval.mockResolvedValue(false);
    await expect(dispatch(ORIGIN, 'balanceSealedTransaction', ['abcd'])).rejects.toMatchObject({ code: 'Rejected' });
    expect(balanceTransaction).not.toHaveBeenCalled();
  });

  it('rejects balanceSealedTransaction with payFees:false as InvalidRequest', async () => {
    await connect();
    await expect(
      dispatch(ORIGIN, 'balanceSealedTransaction', ['abcd', { payFees: false }]),
    ).rejects.toMatchObject({ code: 'InvalidRequest' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects balanceSealedTransaction with non-hex input as InvalidRequest', async () => {
    await connect();
    await expect(dispatch(ORIGIN, 'balanceSealedTransaction', ['zzz'])).rejects.toMatchObject({
      code: 'InvalidRequest',
    });
  });

  it('gates balanceSealedTransaction on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(dispatch(ORIGIN, 'balanceSealedTransaction', ['abcd'])).rejects.toMatchObject({
      code: 'PermissionRejected',
    });
  });

  it('balances an unsealed transaction after approval (sealed: false)', async () => {
    await connect();
    requestApproval.mockResolvedValue(true);
    txSummary.mockResolvedValue(NIGHT_SPEND);
    balanceTransaction.mockResolvedValue({ txHex: 'cafe' });
    const res = await dispatch(ORIGIN, 'balanceUnsealedTransaction', ['abcd']);
    expect(res).toEqual({ tx: 'cafe' });
    expect(requestApproval).toHaveBeenCalledWith(
      'balance',
      ORIGIN,
      { sealed: false, summary: NIGHT_SPEND },
      undefined,
      preparedPanel,
    );
    expect(balanceTransaction).toHaveBeenCalledWith(expect.objectContaining({ txHex: 'abcd', sealed: false }));
  });

  it('gates balanceUnsealedTransaction on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(dispatch(ORIGIN, 'balanceUnsealedTransaction', ['abcd'])).rejects.toMatchObject({
      code: 'PermissionRejected',
    });
  });

  it('builds a swap intent after approval', async () => {
    await connect();
    requestApproval.mockResolvedValue(true);
    makeIntent.mockResolvedValue({ txHex: 'f00d' });
    const inputs = [{ kind: 'unshielded', type: 'a'.repeat(64), value: 5n }];
    const outputs = [{ kind: 'shielded', type: 'b'.repeat(64), value: 3n, recipient: 'mn_shield_devnet' }];
    const res = await dispatch(ORIGIN, 'makeIntent', [inputs, outputs, { intentId: 'random', payFees: true }]);
    expect(res).toEqual({ tx: 'f00d' });
    // Approval shows the outputs (amounts as strings).
    expect(requestApproval).toHaveBeenCalledWith(
      'transfer',
      ORIGIN,
      { outputs: [{ kind: 'shielded', type: 'b'.repeat(64), value: '3', recipient: 'mn_shield_devnet' }] },
      undefined,
      preparedPanel,
    );
    // Inputs/outputs reach the offscreen host as decimal-string DTOs.
    expect(makeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [{ type: 'unshielded', tokenId: 'a'.repeat(64), amount: '5' }],
        outputs: [{ type: 'shielded', tokenId: 'b'.repeat(64), amount: '3', to: 'mn_shield_devnet' }],
        payFees: true,
      }),
    );
  });

  it('rejects makeIntent with no inputs or outputs as InvalidRequest', async () => {
    await connect();
    await expect(dispatch(ORIGIN, 'makeIntent', [[], [], { intentId: 1, payFees: true }])).rejects.toMatchObject({
      code: 'InvalidRequest',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects makeIntent when the user declines', async () => {
    await connect();
    requestApproval.mockResolvedValue(false);
    const outputs = [{ kind: 'shielded', type: 'b'.repeat(64), value: 3n, recipient: 'mn_shield_devnet' }];
    await expect(dispatch(ORIGIN, 'makeIntent', [[], outputs, { payFees: true }])).rejects.toMatchObject({
      code: 'Rejected',
    });
    expect(makeIntent).not.toHaveBeenCalled();
  });

  it('gates makeIntent on prior connect (permission)', async () => {
    await saveSession(SESSION); // unlocked but not granted
    await expect(dispatch(ORIGIN, 'makeIntent', [[], [], { payFees: true }])).rejects.toMatchObject({
      code: 'PermissionRejected',
    });
  });

  // Fix 1: dispatch must bracket EVERY request (incl. read-only ones like the
  // balance getters, which recreate the offscreen doc + start sync) so teardown
  // always gets rescheduled and can't fire mid-request.
  it('brackets a read-only op with beginOp/endOp', async () => {
    await connect();
    balancesGet.mockResolvedValue(serializeBalances(sampleBalances()));
    await dispatch(ORIGIN, 'getShieldedBalances', []);
    expect(beginOp).toHaveBeenCalledTimes(1);
    expect(endOp).toHaveBeenCalledTimes(1);
  });

  it('still calls endOp when the request throws', async () => {
    // Not connected → requireConnected throws inside the switch, after beginOp.
    await expect(dispatch(ORIGIN, 'getShieldedBalances', [])).rejects.toMatchObject({
      code: 'PermissionRejected',
    });
    expect(beginOp).toHaveBeenCalledTimes(1);
    expect(endOp).toHaveBeenCalledTimes(1);
  });
});
