import path from 'node:path';
import fs from 'node:fs';
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';

// Chrome only loads unpacked extensions into a persistent context, and only
// the full Chromium build supports them headless — hence channel: 'chromium'
// rather than the default headless shell.
const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');

test.beforeAll(() => {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(
      `No extension build at ${extensionDir} — run \`yarn workspace @shieldedtech/moth-extension build\` first.`,
    );
  }
});

async function launchExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  // The MV3 background service worker registering is the closest thing to
  // "Chrome accepted the extension": a broken manifest or a background
  // bundle that fails to parse never gets this far.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).host };
}

/** Opens an extension page while collecting uncaught exceptions and console errors. */
async function openPage(
  context: BrowserContext,
  extensionId: string,
  file: string,
): Promise<{ page: Page; problems: string[] }> {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return { page, problems };
}

// A headed run's assertions finish in about a second, before a human can look
// at anything; E2E_HOLD_MS keeps the window open that long.
async function holdForViewing(page: Page): Promise<void> {
  if (process.env.E2E_HOLD_MS) {
    test.setTimeout(Number(process.env.E2E_HOLD_MS) + 30_000);
    await page.waitForTimeout(Number(process.env.E2E_HOLD_MS));
  }
}

test('side panel loads and shows the get-started choice', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    const { page, problems } = await openPage(context, extensionId, 'sidepanel.html');

    await expect(page).toHaveTitle('Moth Wallet');
    // A fresh profile has no wallet, so the landing screen must offer exactly
    // the create-vs-import choice (wording from lib/i18n/messages/welcome.ts).
    await expect(page.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I already have one' })).toBeVisible();

    expect(problems, 'side panel logged errors during load').toEqual([]);
    await holdForViewing(page);
  } finally {
    await context.close();
  }
});

test('setup page loads and shows the welcome choice', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    const { page, problems } = await openPage(context, extensionId, 'setup.html');

    await expect(page).toHaveTitle('Set up Moth');
    // Without ?mode, setup lands on its Welcome screen, which offers the same
    // choice (wording from lib/i18n/messages/setup.ts).
    await expect(page.getByRole('button', { name: 'Create a new wallet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I already have one' })).toBeVisible();

    expect(problems, 'setup page logged errors during load').toEqual([]);
    await holdForViewing(page);
  } finally {
    await context.close();
  }
});
