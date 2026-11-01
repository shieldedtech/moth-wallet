// The dApp connector driven end to end through the real extension UI, with no
// chain: the built mock-dapp asks, the side panel (or the approval popup)
// answers, and the page sees the result. Everything that leaves the machine is
// refused, so these flows must work before the wallet has synced at all.

import { test, expect, type Page } from '@playwright/test';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { DEFAULT_NETWORKS } from '@shieldedtech/moth-wallet/types/network';
import { signedMessageBytes } from '@shieldedtech/moth-wallet/wallet/sign-message';
import {
  API_VERSION,
  EXTENSION_METHODS,
  IMPLEMENTED_METHODS,
  NOT_IMPLEMENTED_METHODS,
  WALLET_NAME,
  WALLET_RDNS,
} from '../lib/connector/constants';
import {
  assertBuilt,
  importWallet,
  isUnlocked,
  launchExtension,
  PASSWORD,
  runAutoLockCheck,
  startMockDapp,
  startRefusingProxy,
  type Extension,
} from './harness';

// Each test imports a wallet into a fresh profile; that alone takes ~10 s.
test.describe.configure({ timeout: 120_000 });

let proxy: Awaited<ReturnType<typeof startRefusingProxy>>;
let dappServer: Awaited<ReturnType<typeof startMockDapp>>;
let ext: Extension;

test.beforeAll(() => assertBuilt());

test.beforeEach(async () => {
  proxy = await startRefusingProxy();
  dappServer = await startMockDapp();
  ext = await launchExtension(proxy.url);
  await importWallet(ext);
});

test.afterEach(async () => {
  await ext.context.close();
  await dappServer.close();
  await proxy.close();
});

const dappHost = () => new URL(dappServer.url).host;

async function openDapp(): Promise<Page> {
  const dapp = await ext.context.newPage();
  await dapp.goto(dappServer.url);
  await expect(dapp.getByText('Moth Wallet detected')).toBeVisible();
  // Preprod is the mock-dapp's default request and the wallet's setup default.
  await expect(dapp.getByRole('combobox', { name: 'Requested network' })).toHaveValue('preprod');
  return dapp;
}

const requestLog = (dapp: Page) => dapp.locator('#request-log');

/** Connects the mock-dapp, approving in the side panel. Returns both pages. */
async function connectApproved(): Promise<{ dapp: Page; panel: Page }> {
  const panel = await ext.page('sidepanel.html');
  const dapp = await openDapp();
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByRole('heading', { name: `Connect to ${dappHost()}?` })).toBeVisible();
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(dapp.getByText('Connected to Moth Wallet')).toBeVisible();
  return { dapp, panel };
}

// The unit tests check the method list against the spec; this checks what a
// real page receives. The proving-provider RPCs must stay internal: the page
// reaches them only through the object getProvingProvider returns.
test('the page gets the announced wallet and exactly the implemented methods', async () => {
  const { dapp } = await connectApproved();
  const surface = await dapp.evaluate(async () => {
    const initial = (window as unknown as { midnight: Record<string, Record<string, unknown>> }).midnight.moth!;
    // Already granted, so this resolves without a prompt.
    const api = await (initial.connect as (id: string) => Promise<object>)('preprod');
    return {
      announced: { name: initial.name, rdns: initial.rdns, apiVersion: initial.apiVersion },
      methods: Object.keys(api).sort(),
    };
  });

  expect(surface.announced).toEqual({ name: WALLET_NAME, rdns: WALLET_RDNS, apiVersion: API_VERSION });
  expect(surface.methods).toEqual(
    [...IMPLEMENTED_METHODS, ...NOT_IMPLEMENTED_METHODS, ...EXTENSION_METHODS].sort(),
  );
});

test('a dApp is refused when the user cancels the connection', async () => {
  const panel = await ext.page('sidepanel.html');
  const dapp = await openDapp();
  await dapp.getByRole('button', { name: 'Connect', exact: true }).click();
  await panel.getByRole('button', { name: 'Cancel' }).click();

  await expect(requestLog(dapp)).toContainText('"code": "Rejected"');
  await expect(dapp.getByText('Connected to Moth Wallet')).toBeHidden();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await expect(panel.getByRole('button', { name: 'Connected sites 0' })).toBeVisible();
});

test('signData returns a signature when signed and Rejected when declined', async () => {
  const { dapp, panel } = await connectApproved();
  await dapp.getByText('Sign arbitrary data').click();
  await dapp.locator('#sign-data').fill('offline e2e message');

  await dapp.getByRole('button', { name: 'Request signature' }).click();
  await expect(panel.getByRole('heading', { name: 'Sign this message?' })).toBeVisible();
  // The user must see exactly what they are signing.
  await expect(panel.getByText('offline e2e message')).toBeVisible();
  await panel.getByRole('button', { name: 'Sign' }).click();
  await expect(requestLog(dapp)).toContainText('"signature":');

  // The signing key also authorizes transactions, so what a dApp gets back must
  // be a signature over the domain-separated message, never over its raw bytes.
  const latest = await requestLog(dapp).locator(':scope > *').first().innerText();
  const signed = JSON.parse(latest.slice(latest.indexOf('{'))) as { signature: string; verifyingKey: string };
  const raw = new TextEncoder().encode('offline e2e message');
  expect(ledger.verifySignature(signed.verifyingKey, signedMessageBytes(raw), signed.signature)).toBe(true);
  expect(ledger.verifySignature(signed.verifyingKey, raw, signed.signature)).toBe(false);

  await dapp.getByRole('button', { name: 'Request signature' }).click();
  await panel.getByRole('button', { name: 'Reject' }).click();
  await expect(requestLog(dapp)).toContainText('"code": "Rejected"');
});

test('an approved site is listed in Connected sites, and revoking it disconnects it', async () => {
  const { dapp, panel } = await connectApproved();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: /^Connected sites/ }).click();
  await expect(panel.getByText(dappHost())).toBeVisible();
  await panel.getByRole('button', { name: 'Revoke' }).click();
  await expect(panel.getByText(dappHost())).toBeHidden();

  await dapp.getByRole('button', { name: 'Connection status' }).click();
  await expect(requestLog(dapp)).toContainText('"status": "disconnected"');

  // The open panel started a sync, and the proxy turned it away. Without this,
  // a proxy Chrome bypassed would leave the whole suite quietly online.
  const indexerHost = new URL(DEFAULT_NETWORKS.preprod!.indexerUrl).hostname;
  await expect.poll(() => proxy.refusedHosts()).toContain(indexerHost);
});

// With no user gesture behind the request, Chrome will not open the side
// panel, so the approval falls back to its own popup window.
test('without a user gesture the approval opens in a popup', async () => {
  const dapp = await openDapp();
  const popup = ext.context.waitForEvent('page', (page) => page.url().includes('/approval.html'));
  // Playwright's evaluate carries a user gesture; Chrome's transient activation
  // lasts five seconds, so wait it out before asking.
  const outcome = dapp.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const moth = (window as unknown as { midnight: Record<string, { connect(id: string): Promise<unknown> }> })
      .midnight.moth;
    return moth.connect('preprod').then(
      () => 'connected',
      (err: { code?: string }) => `refused: ${err.code}`,
    );
  });

  const approval = await popup;
  await expect(approval.getByRole('heading', { name: `Connect to ${dappHost()}?` })).toBeVisible();
  await approval.getByRole('button', { name: 'Connect' }).click();
  expect(await outcome).toBe('connected');
  await expect.poll(() => approval.isClosed()).toBe(true);
});

test('auto-lock locks a connected wallet, and unlocking restores the dApp', async () => {
  const { dapp, panel } = await connectApproved();
  // A panel open on a sync that started moments ago legitimately defers the
  // lock (a watched sync), so lock with the panel closed, as a user who walked away would.
  await panel.close();

  await runAutoLockCheck(ext, 120);
  await expect.poll(() => isUnlocked(ext)).toBe(false);

  await dapp.getByRole('button', { name: 'All addresses' }).click();
  await expect(requestLog(dapp)).toContainText('"code": "Disconnected"');

  const unlock = await ext.page('sidepanel.html');
  await unlock.getByPlaceholder('Password').fill(PASSWORD);
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByRole('button', { name: 'Settings' })).toBeVisible();

  // The grant survives the lock, so the dApp's existing connection works again.
  await dapp.getByRole('button', { name: 'All addresses' }).click();
  await expect(requestLog(dapp)).toContainText('mn_addr_preprod');
});
