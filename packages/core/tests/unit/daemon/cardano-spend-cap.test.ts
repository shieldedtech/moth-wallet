import {beforeEach, describe, expect, it, vi} from 'vitest';
import {resolveCardanoNetwork} from '../../../src/cardano/network.js';

// cardanoSend once ignored --max-spend, so an auto-approve daemon would move any
// amount of ADA or cNIGHT on request. These pin the headless Cardano caps.

const config = resolveCardanoNetwork('preview');
const CNIGHT = config.cnightPolicyId + config.cnightAssetName;
const TO = 'addr_test1qryvgass5dsrf2kxl3vgfz76uhp83kv5lagzcp29tcana68ca5aqa6swlq6llfamln09tal7n5kvt4275ckwedpt4v7q48uhex';

/** What the builder was asked to pay; reaching it means the cap let the send through. */
const paid: Array<Record<string, bigint>> = [];

vi.mock('../../../src/cardano/session.js', () => ({
  withCardanoSession: async (_mnemonic: string, cfg: unknown, fn: (session: unknown) => Promise<unknown>) =>
    fn({
      config: cfg,
      lucid: {
        config: () => ({protocolParameters: {coinsPerUtxoByte: 4310n}}),
        wallet: () => ({getUtxos: async () => [{assets: {lovelace: 100_000_000n, [CNIGHT]: 50_000_000n}}]}),
        newTx: () => ({
          pay: {ToAddress: (_to: string, assets: Record<string, bigint>) => { paid.push(assets); }},
          complete: async () => { throw new Error('stop-before-signing'); },
        }),
      },
    }),
}));

import {buildWalletHandlers, type WalletHandlerDeps} from '../../../src/daemon/wallet-handlers.js';
import {ConfirmationQueue} from '../../../src/daemon/confirmation-queue.js';
import {DEFAULT_NETWORKS} from '../../../src/types/network.js';

function handlers(cardanoSpendCap?: WalletHandlerDeps['cardanoSpendCap']) {
  return buildWalletHandlers({
    walletName: 'w',
    network: DEFAULT_NETWORKS.preview!,
    getFacade: () => null,
    getWalletKeys: () => null,
    getBalances: () => null,
    queue: new ConfirmationQueue({autoApprove: true}),
    ...(cardanoSpendCap ? {cardanoSpendCap} : {}),
    cardano: {
      config: {...config, blockfrostProjectId: 'unused'},
      resolveAccountKey: async () => ({mnemonic: 'unused', accountIndex: 0}),
      getDustAddress: () => '',
    },
  });
}

const send = (h: ReturnType<typeof handlers>, params: Record<string, string>) =>
  h.cardanoSend!({to: TO, ...params}, undefined as never);

beforeEach(() => { paid.length = 0; });

describe('cardanoSend spend caps', () => {
  it('leaves an interactive host uncapped, since a human approves each send', async () => {
    await expect(send(handlers(), {lovelace: '50000000'})).rejects.toThrow(/stop-before-signing/);
    expect(paid).toEqual([{lovelace: 50_000_000n}]);
  });

  it('refuses an unattended send of an asset with no cap', async () => {
    const h = handlers({lovelace: null, cnight: 10_000_000n});
    await expect(send(h, {lovelace: '2000000'})).rejects.toMatchObject({code: 'UNAUTHORIZED'});
    const adaOnly = handlers({lovelace: 5_000_000n, cnight: null});
    await expect(send(adaOnly, {lovelace: '2000000', cnight: '1000000'})).rejects.toThrow(/--max-spend-cnight/);
    expect(paid).toEqual([]);
  });

  it('refuses amounts over the cap and lets one within it through', async () => {
    const h = handlers({lovelace: 5_000_000n, cnight: 10_000_000n});
    await expect(send(h, {lovelace: '6000000'})).rejects.toThrow(/exceeds the --max-spend-ada cap of 5 ADA/);
    await expect(send(h, {cnight: '11000000'})).rejects.toThrow(/exceeds the --max-spend-cnight cap/);
    await expect(send(h, {lovelace: '2000000', cnight: '1000000'})).rejects.toThrow(/stop-before-signing/);
    expect(paid).toHaveLength(1);
  });

  it('counts the minimum ADA a cNIGHT-only send carries against the ADA cap', async () => {
    const h = handlers({lovelace: 1_000_000n, cnight: 10_000_000n});
    await expect(send(h, {cnight: '1000000'})).rejects.toThrow(/--max-spend-ada/);
    expect(paid).toEqual([]);
  });
});
