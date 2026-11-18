import path from 'node:path';
import fs from 'node:fs';
import { test, expect, chromium, type BrowserContext } from '@playwright/test';

const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');

// The extension page's global, used only inside page.evaluate.
declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };

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
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).host };
}

// A fresh install has no account, so no Settings screen: the network step is
// the only place developer mode, and with it mainnet, can be turned on.
test('first-run setup can turn on developer mode and choose mainnet', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await page.goto(`chrome-extension://${extensionId}/setup.html?mode=create`);

    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a network' })).toBeVisible();

    const mainnet = page.getByRole('radio', { name: /^Mainnet/ });
    await expect(mainnet).toHaveCount(0);
    await page.getByRole('button', { name: 'Turn on Developer mode' }).click();
    await expect(mainnet).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn on Developer mode' })).toHaveCount(0);

    // Choosing it asks for the same real-funds acknowledgement as Settings.
    await mainnet.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    const warning = page.getByRole('dialog', { name: 'Switch to Mainnet — real funds?' });
    await expect(warning).toBeVisible();

    await warning.getByRole('button', { name: 'Cancel' }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Choose a network' })).toBeVisible();

    await page.getByRole('button', { name: 'Continue' }).click();
    await warning.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create a password' })).toBeVisible();

    // Persisted wallet-wide, so Settings shows it on once the account exists.
    const stored = await page.evaluate(() => chrome.storage.local.get('settings'));
    expect(stored.settings).toMatchObject({ developerMode: true, network: 'mainnet' });
    expect(problems, 'setup page threw during the flow').toEqual([]);
  } finally {
    await context.close();
  }
});
