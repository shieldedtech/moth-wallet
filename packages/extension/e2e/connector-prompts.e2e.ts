import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { assertBuilt, launchExtension } from './extension';

// A dApp page that raises a prompt and is then reloaded or closed must not leave
// that prompt behind: it held the queue, so the next request from the same
// site waited behind a decision nobody could deliver (Dust Dice, 2026-11-03).
// The side panel is stood in for by its page opened in a tab, which holds the
// same port the real panel does, so approvals surface there.

// https: the page-side client needs a secure context for crypto.randomUUID, as real dApps have.
const DAPP_ORIGIN = 'https://dapp.test';
const NETWORK = 'preprod'; // the setup default, so the network step is just "Continue"
const PASSPHRASE = 'moth e2e pass phrase';

test.beforeAll(assertBuilt);
// Chromium start, two scrypt derivations and a cold WASM worker add up.
test.setTimeout(180_000);

/** Import a throwaway wallet from a fixed hex seed and leave it unlocked. */
async function importWallet(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html?mode=import`);
  // Wording from lib/i18n/messages/setup.ts.
  await page.getByRole('tab', { name: 'Hex seed' }).click();
  await page.getByLabel('Hex seed').fill('11'.repeat(32));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a network' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create a password' })).toBeVisible();
  await page.locator('#setup-password').fill(PASSPHRASE);
  await page.locator('#setup-confirm').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible({ timeout: 90_000 });
  await page.close();
}

async function openDapp(context: BrowserContext): Promise<Page> {
  await context.route(`${DAPP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dapp</title><p>dapp</p>' }),
  );
  const page = await context.newPage();
  await page.goto(`${DAPP_ORIGIN}/`);
  await waitForProvider(page);
  return page;
}

async function waitForProvider(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { midnight?: { moth?: unknown } }).midnight?.moth));
}

type Outcome = { ok: true; value?: string } | { ok: false; code?: string; reason?: string };

/** Start connect() and park the outcome on the page; the promise is awaited later. */
async function startConnect(page: Page): Promise<void> {
  await page.evaluate((networkId) => {
    const w = window as unknown as {
      midnight: { moth: { connect(id: string): Promise<unknown> } };
      __api?: unknown;
      __connect?: Promise<Outcome>;
    };
    w.__connect = w.midnight.moth.connect(networkId).then(
      (api) => {
        w.__api = api;
        return { ok: true as const };
      },
      (err: { code?: string; reason?: string; message?: string }) => ({
        ok: false as const,
        code: err.code,
        reason: err.reason ?? err.message,
      }),
    );
  }, NETWORK);
}

async function startDerive(page: Page, domain: string): Promise<void> {
  await page.evaluate((d) => {
    const w = window as unknown as {
      __api: { deriveAppSecret(domain: string): Promise<{ secret: string }> };
      __derive?: Promise<Outcome>;
    };
    w.__derive = w.__api.deriveAppSecret(d).then(
      (result) => ({ ok: true as const, value: result.secret }),
      (err: { code?: string; reason?: string; message?: string }) => ({
        ok: false as const,
        code: err.code,
        reason: err.reason ?? err.message,
      }),
    );
  }, domain);
}

const outcome = (page: Page, key: '__connect' | '__derive'): Promise<Outcome> =>
  page.evaluate((k) => (window as unknown as Record<string, Promise<Outcome>>)[k]!, key);

// Wording from lib/i18n/messages/approval.ts.
const connectPrompt = (panel: Page) => panel.getByRole('heading', { name: /dapp\.test\?/ });
const derivePrompt = (panel: Page) => panel.getByRole('heading', { name: 'Allow an app secret?' });

/** Connect the dApp page, approving on the panel, so later calls need no connect prompt. */
async function connectApproved(dapp: Page, panel: Page): Promise<void> {
  await startConnect(dapp);
  await expect(connectPrompt(panel)).toBeVisible();
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(await outcome(dapp, '__connect')).toEqual({ ok: true });
}

/** Approve the derive prompt on the panel and return the secret with the wait after the click. */
async function allowDerive(dapp: Page, panel: Page): Promise<{ secret: string; waitedMs: number }> {
  await expect(derivePrompt(panel)).toBeVisible();
  const clickedAt = Date.now();
  await panel.getByRole('button', { name: 'Allow', exact: true }).click();
  const result = await outcome(dapp, '__derive');
  const waitedMs = Date.now() - clickedAt;
  expect(result).toMatchObject({ ok: true });
  const secret = (result as { value: string }).value;
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  return { secret, waitedMs };
}

test('a prompt left behind by a reloaded page is dropped and the reloaded page is answered', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    await importWallet(context, extensionId);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const dapp = await openDapp(context);

    // Recipe (a): reload while the prompt is open, without answering.
    await startConnect(dapp);
    await expect(connectPrompt(panel)).toBeVisible();
    await dapp.reload();
    await expect(connectPrompt(panel)).toBeHidden();

    // The reloaded page's own request must be the one shown and answered.
    await waitForProvider(dapp);
    await connectApproved(dapp, panel);

    await startDerive(dapp, 'dust-dice-test');
    const { waitedMs } = await allowDerive(dapp, panel);
    console.log(`deriveAppSecret answered ${waitedMs} ms after Allow`);
    // The sync lane may be restoring or dialing an unreachable node meanwhile; a
    // seed-only derivation must not wait on it.
    expect(waitedMs).toBeLessThan(15_000);
  } finally {
    await context.close();
  }
});

test('a prompt left behind by a closed tab is dropped and another tab gets the same secret', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    await importWallet(context, extensionId);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    const first = await openDapp(context);
    await connectApproved(first, panel);
    await startDerive(first, 'dust-dice-seat:table-1');
    const { secret: expected } = await allowDerive(first, panel);

    // Recipe (b): close the tab with its prompt open; request from a fresh tab.
    await startDerive(first, 'dust-dice-seat:table-1');
    await expect(derivePrompt(panel)).toBeVisible();
    await first.close();
    await expect(derivePrompt(panel)).toBeHidden();

    const second = await openDapp(context);
    await startConnect(second); // already granted: no prompt
    await expect(await outcome(second, '__connect')).toEqual({ ok: true });
    await startDerive(second, 'dust-dice-seat:table-1');
    const { secret, waitedMs } = await allowDerive(second, panel);
    console.log(`deriveAppSecret answered ${waitedMs} ms after Allow`);
    // Same wallet, origin and domain: the dApp relies on this to find held seats.
    expect(secret).toBe(expected);
  } finally {
    await context.close();
  }
});
