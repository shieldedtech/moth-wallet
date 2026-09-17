import path from 'node:path';
import fs from 'node:fs';
import { test, expect, chromium } from '@playwright/test';

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

test('extension loads: service worker registers and the side panel renders', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });

  try {
    // The MV3 background service worker registering is the closest thing to
    // "Chrome accepted the extension": a broken manifest or a background
    // bundle that fails to parse never gets this far.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page).toHaveTitle('Moth Wallet');
    // React mounting something into #root proves the UI bundle executed.
    await expect(page.locator('#root > *').first()).toBeVisible();

    expect(pageErrors, 'side panel threw during load').toEqual([]);
  } finally {
    await context.close();
  }
});
