import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// A CIP-30 signature used to be approved on the method name alone. These tests
// pin what the approval now names, and that the key it names is the one that signs.

const cardanoCip30 = vi.fn<(data: { accountIndex: number; mnemonic: string }) => Promise<string>>();
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: { cardanoCip30: (data: { accountIndex: number; mnemonic: string }) => cardanoCip30(data) },
}));

const requestApproval = vi.fn<(kind: string, origin: string, payload: unknown) => Promise<boolean>>();
vi.mock('../lib/background/approvals', () => ({
  requestApproval: (kind: string, origin: string, payload: unknown) => requestApproval(kind, origin, payload),
  prepareApprovalPanel: vi.fn(() => Promise.resolve(true)),
  getApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  resolveApproval: vi.fn(),
  hasPendingApproval: vi.fn(() => false),
}));

vi.mock('../lib/background/sync-service', () => ({ beginOp: vi.fn(), endOp: vi.fn() }));

const requireCardano = vi.fn();
vi.mock('../lib/background/cardano-session', () => ({ requireCardano: (needs: boolean) => requireCardano(needs) }));

import { dispatch } from '../lib/background/connector-handlers';
import { grant } from '../lib/background/permissions';

const ORIGIN = 'https://cardano-dapp.example';
// The relay forwards `cardano.*` methods through the Midnight-typed dispatcher.
const SIGN_TX = 'cardano.signTx' as Parameters<typeof dispatch>[1];

const CONTEXT = {
  session: { walletName: 'alice', network: 'preprod' },
  config: { network: 'Preprod' },
  mnemonic: 'imported phrase',
  accountIndex: 0,
  account: { id: 'acc-2', label: 'Savings', kind: 'imported' as const },
};

describe('CIP-30 signing approval', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    await grant(ORIGIN, 'preprod');
    requireCardano.mockResolvedValue(CONTEXT);
    cardanoCip30.mockResolvedValue('witness-set');
  });

  it('names the Cardano network, wallet and signing account', async () => {
    requestApproval.mockResolvedValue(true);
    await dispatch(ORIGIN, SIGN_TX, ['84a4…']);
    expect(requestApproval).toHaveBeenCalledWith('cardanoSign', ORIGIN, {
      method: 'signTx',
      cardanoNetwork: 'Preprod',
      walletName: 'alice',
      accountLabel: 'Savings',
      accountKind: 'imported',
    });
  });

  it('signs with the key resolved for the approval, not one read afterwards', async () => {
    requestApproval.mockImplementation(async () => {
      // The user switches account while the prompt is open.
      requireCardano.mockResolvedValue({ ...CONTEXT, mnemonic: 'other phrase', accountIndex: 3 });
      return true;
    });
    await dispatch(ORIGIN, SIGN_TX, ['84a4…']);
    expect(requireCardano).toHaveBeenCalledTimes(1);
    expect(cardanoCip30).toHaveBeenCalledWith(expect.objectContaining({ mnemonic: 'imported phrase', accountIndex: 0 }));
  });

  it('does not sign when the user declines', async () => {
    requestApproval.mockResolvedValue(false);
    await expect(dispatch(ORIGIN, SIGN_TX, ['84a4…'])).rejects.toBeDefined();
    expect(cardanoCip30).not.toHaveBeenCalled();
  });
});
