// What an error is allowed to tell an untrusted page.
//
// The connector reduces every failure to {code, reason}, and `reason` travels
// verbatim to the dApp. describeErrorFields folds an error's structured fields
// into it, so the set of fields it will copy is a disclosure decision, not a
// formatting one — hence an allowlist, and hence these tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { describeErrorFields } from '../lib/connector/errors';

class WalletError extends Error {
  readonly category: string;
  constructor(category: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WalletError';
    this.category = category;
  }
}

describe('describeErrorFields', () => {
  it('forwards the fields a dApp needs to act on', () => {
    const err = new Error('Insufficient funds for fallible segment 31897');
    Object.assign(err, { tokenType: '0'.repeat(64), amount: 31897n });
    expect(describeErrorFields(err)).toBe(`tokenType=${'0'.repeat(64)}, amount=31897`);
  });

  it('follows a cause chain that carries them', () => {
    const inner = new Error('shortfall');
    Object.assign(inner, { tokenType: 'night' });
    const outer = new Error('balancing failed', { cause: inner });
    Object.assign(outer, { amount: 5n });
    expect(describeErrorFields(outer)).toBe('amount=5, tokenType=night');
  });

  // --- disclosure boundary -------------------------------------------------
  // Each of these reproduced against the previous denylist implementation.

  it('does not forward an HTTP context hung off a cause', () => {
    const err = new WalletError('network', 'fetch failed', {
      url: 'https://user:tok@indexer.example/graphql?key=SECRET',
      status: 502,
      body: '<html>internal</html>',
    });
    expect(describeErrorFields(err)).toBe('');
  });

  it('does not forward a stack trace attached as a field', () => {
    // core/contract/deploy.ts attaches err.stack as `originalStack`.
    const err = new WalletError('wallet', 'deploy failed');
    Object.assign(err, { originalStack: 'Error: boom\n    at /Users/someone/project/deploy.ts:471:9' });
    expect(describeErrorFields(err)).toBe('');
  });

  it('does not forward a large payload', () => {
    const err = new WalletError('network', 'fetch failed');
    Object.assign(err, { responseText: 'A'.repeat(200_000) });
    expect(describeErrorFields(err)).toBe('');
  });

  it('caps an allowlisted value that arrives oversized', () => {
    const err = new Error('short');
    Object.assign(err, { tokenType: 'A'.repeat(5_000) });
    const out = describeErrorFields(err);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves an ordinary error untouched, so existing reasons do not change', () => {
    // A plain WalletError gained "[category=WALLET_ERROR]" under the denylist,
    // which would break a dApp matching exact reason strings.
    expect(describeErrorFields(new WalletError('WALLET_ERROR', 'locked'))).toBe('');
    expect(describeErrorFields(new Error('Invalid hex data'))).toBe('');
  });

  it('ignores non-Error throwables', () => {
    // An array yielded "0=a, 1=b, length=2" under the denylist.
    expect(describeErrorFields(['a', 'b'])).toBe('');
    expect(describeErrorFields('a string')).toBe('');
    expect(describeErrorFields({ tokenType: 'night' })).toBe('');
    expect(describeErrorFields(null)).toBe('');
  });

  it('does not walk a plain-object cause', () => {
    expect(describeErrorFields(new Error('x', { cause: { tokenType: 'night' } }))).toBe('');
  });

  it('bounds the depth it will walk', () => {
    let err = new Error('deepest');
    Object.assign(err, { tokenType: 'too-deep' });
    for (let i = 0; i < 5; i++) err = new Error(`level ${i}`, { cause: err });
    expect(describeErrorFields(err)).toBe('');
  });
});

// The fold itself: proves the suffix reaches the reason a dApp receives, and
// that an error with nothing to add leaves the reason byte-identical.
//
// Driven through the registered `connectorRequest` handler rather than
// `dispatch`, because the fold lives in that handler's catch.

const { handlers, balanceTransaction, txSummary } = vi.hoisted(() => ({
  handlers: new Map<string, (m: unknown) => Promise<unknown>>(),
  balanceTransaction: vi.fn(),
  txSummary: vi.fn(),
}));

vi.mock('../lib/messaging/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/messaging/protocol')>()),
  onMessage: (key: string, fn: (m: unknown) => Promise<unknown>) => {
    handlers.set(key, fn);
  },
}));
vi.mock('../lib/background/offscreen-client', () => ({
  offscreen: {
    balanceTransaction: (...a: unknown[]) => balanceTransaction(...(a as [])),
    txSummary: (...a: unknown[]) => txSummary(...(a as [])),
  },
}));
vi.mock('../lib/background/approvals', () => ({
  requestApproval: vi.fn(async () => true),
  prepareApprovalPanel: vi.fn(async () => true),
  getApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  resolveApproval: vi.fn(),
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../lib/background/sync-service', () => ({ beginOp: vi.fn(), endOp: vi.fn() }));

import { registerConnectorHandlers } from '../lib/background/connector-handlers';
import { grant } from '../lib/background/permissions';
import { saveSession, type Session } from '../lib/background/session';
import { encodeBigintJson } from '../lib/messaging/bigint-json';

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

describe('the reason a dApp receives', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    handlers.clear();
    balanceTransaction.mockReset();
    txSummary.mockReset();
    txSummary.mockResolvedValue({ spends: [], receives: [], contractActions: 0 });
    registerConnectorHandlers();
    await grant(ORIGIN, 'devnet');
    await saveSession(SESSION);
  });

  // balanceSealedTransaction, because that is the path the motivating error
  // takes: it awaits offscreen.balanceTransaction without a try/catch, so the
  // error arrives at the handler's catch with its fields intact. Paths that
  // remap through connectorError (signData does) discard them before the fold
  // ever sees them.
  async function reasonFor(err: unknown): Promise<string> {
    balanceTransaction.mockRejectedValue(err);
    const res = (await handlers.get('connectorRequest')!({
      data: { method: 'balanceSealedTransaction', paramsJson: encodeBigintJson(['00ff']) },
      sender: { origin: ORIGIN },
    })) as { ok: boolean; error: { reason: string } };
    expect(res.ok).toBe(false);
    return res.error.reason;
  }

  it('appends allowlisted detail', async () => {
    const err = new Error('Insufficient funds for fallible segment 31897');
    Object.assign(err, { tokenType: 'night', amount: 31897n });
    expect(await reasonFor(err)).toBe(
      'Insufficient funds for fallible segment 31897 [tokenType=night, amount=31897]',
    );
  });

  it('leaves a reason with nothing to add byte-identical', async () => {
    expect(await reasonFor(new WalletError('WALLET_ERROR', 'Invalid hex data'))).toBe('Invalid hex data');
  });

  it('does not let a cause HTTP context into the reason', async () => {
    const err = new WalletError('network', 'fetch failed', {
      url: 'https://user:tok@indexer.example/graphql?key=SECRET',
      status: 502,
    });
    expect(await reasonFor(err)).toBe('fetch failed');
  });
});
