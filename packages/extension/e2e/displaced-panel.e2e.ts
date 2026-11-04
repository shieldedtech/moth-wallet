import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { assertBuilt, launchExtension } from './extension';

// Opening another extension's side panel covers Moth's without closing it, so
// Moth's panel keeps its port and the background believed a prompt sent there
// was on screen. The dApp request then waited until the user opened Moth by
// hand (Brave with 1AM, 2026-11-04). Playwright cannot see side panels, so the
// real panel is read and driven through chrome.extension.getViews() from a
// sibling Moth page.

const OTHER_PANEL = path.resolve(import.meta.dirname, 'fixtures', 'other-panel');
const DAPP_ORIGIN = 'https://dapp.test';
const PASSPHRASE = 'moth e2e pass phrase';

// Code evaluated inside extension pages sees the chrome.* API; this test's
// tsconfig has no chrome types, so the few calls used are declared here.
type ExtensionView = { location: { pathname: string }; document: Document };
type ChromeApi = {
  windows: { getCurrent(): Promise<{ id?: number }> };
  sidePanel: { open(options: { windowId: number }): Promise<void> };
  extension: { getViews(): ExtensionView[] };
};
declare const chrome: ChromeApi;

test.beforeAll(assertBuilt);
test.setTimeout(180_000);

async function importWallet(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html?mode=import`);
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

/** Open an extension's real side panel from one of its own pages. */
async function openSidePanel(context: BrowserContext, extensionId: string, file: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  await page.evaluate(async () => {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id! });
  });
  return page;
}

type PanelView = { visibility: DocumentVisibilityState; heading: string | null };

/** What Moth's real side panel shows, read through a sibling extension page. */
async function mothPanel(mothPage: Page): Promise<PanelView | null> {
  return mothPage.evaluate(() => {
    const view = chrome.extension.getViews().find((v) => v.location.pathname === '/sidepanel.html');
    if (!view) return null;
    return { visibility: view.document.visibilityState, heading: view.document.querySelector('h1')?.textContent ?? null };
  });
}

async function clickInMothPanel(mothPage: Page, name: string): Promise<void> {
  await mothPage.evaluate((buttonName) => {
    const view = chrome.extension.getViews().find((v) => v.location.pathname === '/sidepanel.html')!;
    const button = [...view.document.querySelectorAll('button')].find((b) => b.textContent?.trim() === buttonName);
    if (!button) throw new Error(`no "${buttonName}" button in the side panel`);
    button.click();
  }, name);
}

test('a prompt reaches the user when another extension has covered the Moth panel', async () => {
  const { context, extensionId } = await launchExtension([OTHER_PANEL]);
  try {
    await importWallet(context, extensionId);
    const moth = await openSidePanel(context, extensionId, 'approval.html');
    await expect.poll(() => mothPanel(moth)).toMatchObject({ visibility: 'visible' });

    const otherId = await findOtherId(context, extensionId);
    await openSidePanel(context, otherId, 'opener.html');
    await expect.poll(() => mothPanel(moth)).toMatchObject({ visibility: 'hidden' });

    await context.route(`${DAPP_ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dapp</title><p>dapp</p>' }),
    );
    const dapp = await context.newPage();
    await dapp.goto(`${DAPP_ORIGIN}/`);
    await dapp.waitForFunction(() => Boolean((window as unknown as { midnight?: { moth?: unknown } }).midnight?.moth));
    await dapp.evaluate(() => {
      const w = window as unknown as { midnight: { moth: { connect(id: string): Promise<unknown> } }; __c?: Promise<string> };
      w.__c = w.midnight.moth.connect('preprod').then(
        () => 'connected',
        (e: { reason?: string; message?: string }) => `rejected: ${e.reason ?? e.message}`,
      );
    });

    // The covered panel must be brought back with the prompt on it.
    await expect.poll(() => mothPanel(moth), { timeout: 10_000 }).toMatchObject({
      visibility: 'visible',
      heading: expect.stringContaining('dapp.test'),
    });
    await clickInMothPanel(moth, 'Connect');
    await expect(dapp.evaluate(() => (window as unknown as { __c: Promise<string> }).__c)).resolves.toBe('connected');
  } finally {
    await context.close();
  }
});

async function findOtherId(context: BrowserContext, mothId: string): Promise<string> {
  // chrome.management is not in Moth's permissions, so list the other
  // extension's pages by loading its manifest through a known id is not
  // possible either. The persistent context's service workers show only
  // Moth; the other extension has none. Use its stable unpacked-extension id,
  // derived from the directory path, by asking Chrome via the chrome://
  // extensions internals page.
  const page = await context.newPage();
  await page.goto('chrome://extensions-internals/');
  const json = await page.evaluate(() => document.body.innerText);
  await page.close();
  const entries = JSON.parse(json) as Array<{ id: string; name: string }>;
  const other = entries.find((e) => e.id !== mothId && e.name.startsWith('Other Panel'));
  if (!other) throw new Error('other-panel extension not loaded');
  return other.id;
}
