// The dApp connector's full transaction round trip against a real local chain:
// the mock-dapp asks the wallet to build a transfer without fees, has it
// balanced with fees, submits it, and the indexer confirms the recipient was
// paid. This is the only tier where proving, balancing and submission run for
// real behind the connector.
//
// Needs the local stack on the `undeployed` preset's ports:
//
//   packages/extension/e2e/chain/stack.sh up -d --wait
//   MOTH_E2E_CHAIN=1 yarn workspace @shieldedtech/moth-extension test:e2e connector-chain

import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_NETWORKS, resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';
import { deriveAllAddressesFromSeed } from '@shieldedtech/moth-wallet/wallet/address';
import {
  assertBuilt,
  importWallet,
  launchExtension,
  startMockDapp,
  startRefusingProxy,
  waitForSynced,
  type Extension,
} from './harness';

// Pre-funded with NIGHT and DUST in the local chain's genesis block.
const GENESIS_SEED = '0'.repeat(63) + '1';
const RECIPIENT = deriveAllAddressesFromSeed('ab'.repeat(32)).nightExternal.bech32m.undeployed!;
const AMOUNT = 1_000_000n;
const NIGHT = '0'.repeat(64);
const INDEXER = DEFAULT_NETWORKS.undeployed!.indexerUrl;

test.skip(!process.env.MOTH_E2E_CHAIN, 'needs the local chain stack; set MOTH_E2E_CHAIN=1');
test.describe.configure({ timeout: 300_000 });

let proxy: Awaited<ReturnType<typeof startRefusingProxy>>;
let dappServer: Awaited<ReturnType<typeof startMockDapp>>;
let ext: Extension;

test.beforeAll(async () => {
  assertBuilt();
  const ready = await fetch(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ block { height } }' }),
  }).catch(() => null);
  if (!ready?.ok) throw new Error(`No indexer at ${INDEXER} — start it with packages/extension/e2e/chain/stack.sh up -d --wait.`);

  // The proof server has no container healthcheck, and it is only listening
  // once its proving parameters have downloaded, so `up --wait` cannot cover it.
  const prover = resolveProverConfig(DEFAULT_NETWORKS.undeployed!);
  if (prover.type !== 'server') throw new Error('The undeployed preset is expected to use a proof server.');
  await expect
    .poll(async () => (await fetch(`${prover.url}/ready`).catch(() => null))?.ok ?? false, {
      message: `Proof server at ${prover.url} never became ready — see \`stack.sh logs proof-server\`.`,
      timeout: 180_000,
      intervals: [2_000],
    })
    .toBe(true);
});

test.beforeEach(async () => {
  // The stack is on loopback, which Chrome sends direct; anything else is still refused.
  proxy = await startRefusingProxy();
  dappServer = await startMockDapp();
  ext = await launchExtension(proxy.url);
  await importWallet(ext, { seed: GENESIS_SEED, network: 'Undeployed' });
});

test.afterEach(async () => {
  await ext.context.close();
  await dappServer.close();
  await proxy.close();
});

const requestLog = (dapp: Page) => dapp.locator('#request-log');

/** Waits for the newest request in the mock-dapp log to finish, and returns its output. */
async function latestResult(dapp: Page, method: string): Promise<string> {
  const latest = requestLog(dapp).locator(':scope > *').first();
  await expect(latest).toContainText(method);
  await expect(latest).not.toContainText('Waiting for wallet response', { timeout: 120_000 });
  return latest.innerText();
}

/** Every transaction hash the connected wallet reports, read through the connector. */
function historyHashes(dapp: Page): Promise<Array<{ txHash: string; status: string; result: string }>> {
  return dapp.evaluate(async () => {
    type Api = { getTxHistory(page: number, size: number): Promise<Array<{ txHash: string; txStatus: any }>> };
    const moth = (window as unknown as { midnight: Record<string, { connect(id: string): Promise<Api> }> }).midnight.moth;
    // Already granted, so this resolves without a prompt.
    const api = await moth.connect('undeployed');
    const all: Array<{ txHash: string; status: string; result: string }> = [];
    for (let page = 0; ; page++) {
      const entries = await api.getTxHistory(page, 100);
      for (const e of entries) {
        all.push({ txHash: e.txHash, status: e.txStatus.status, result: e.txStatus.executionStatus?.[0] ?? '' });
      }
      if (entries.length < 100) return all;
    }
  });
}

async function indexerOutputs(hash: string): Promise<Array<{ owner: string; value: string; tokenType: string }>> {
  const response = await fetch(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ transactions(offset: { hash: "${hash}" }) { unshieldedCreatedOutputs { owner value tokenType } } }`,
    }),
  });
  const body = (await response.json()) as {
    data: { transactions: Array<{ unshieldedCreatedOutputs: Array<{ owner: string; value: string; tokenType: string }> }> };
  };
  return body.data.transactions.flatMap((tx) => tx.unshieldedCreatedOutputs);
}

test('a dApp transfer is built, balanced with fees, submitted and lands on chain', async () => {
  const panel = await ext.page('sidepanel.html');
  await waitForSynced(panel);

  const dapp = await ext.context.newPage();
  await dapp.goto(dappServer.url);
  await dapp.getByRole('combobox', { name: 'Requested network' }).fill('undeployed');
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click();
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(dapp.getByText('Connected to Moth Wallet')).toBeVisible();
  const before = new Set((await historyHashes(dapp)).map((entry) => entry.txHash));

  // 1. The wallet builds the transfer but leaves the fee for someone else.
  await dapp.getByText('Build a transfer').click();
  await dapp.locator('#transfer-value').fill(String(AMOUNT));
  await dapp.locator('#transfer-recipient').fill(RECIPIENT);
  await dapp.locator('#transfer-fees').uncheck();
  await dapp.locator('#transfer-form button[type=submit]').click();
  await expect(panel.getByRole('heading', { name: 'Approve this transaction?' })).toBeVisible();
  await expect(panel.getByText('Not paid by this wallet')).toBeVisible();
  await panel.getByRole('button', { name: 'Approve' }).click();
  expect(await latestResult(dapp, 'makeTransfer')).toContain('"tx":');

  // 2. The same wallet then pays the fee by balancing the sealed transaction.
  await dapp.locator('#balance-type').selectOption('sealed');
  await dapp.locator('#balance-fees').check();
  await dapp.locator('#balance-transaction').click();
  await expect(panel.getByRole('heading', { name: 'Approve this transaction?' })).toBeVisible();
  await expect(panel.getByText('Paid in tDUST')).toBeVisible();
  await panel.getByRole('button', { name: 'Approve' }).click();
  expect(await latestResult(dapp, 'balanceSealedTransaction')).toContain('"bindingStage": "sealed"');

  // 3. Submitted through the connector.
  await dapp.locator('#submit-transaction').click();
  expect(await latestResult(dapp, 'submitTransaction')).toContain('"submitted": true');

  // The wallet reports exactly one new transaction, finalized and successful...
  let added: Awaited<ReturnType<typeof historyHashes>> = [];
  await expect
    .poll(
      async () => {
        added = (await historyHashes(dapp)).filter((entry) => !before.has(entry.txHash));
        return added.map(({ status, result }) => `${status}/${result}`);
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toEqual(['finalized/Success']);

  // ...and the indexer, independently of the wallet, shows the recipient paid.
  const outputs = await indexerOutputs(added[0]!.txHash);
  expect(outputs).toContainEqual({ owner: RECIPIENT, value: String(AMOUNT), tokenType: NIGHT });
});
