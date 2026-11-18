import path from 'node:path';
import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

// Chrome only loads unpacked extensions into a persistent context, and only
// the full Chromium build supports them headless — hence channel: 'chromium'
// rather than the default headless shell.
export const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');

export function assertBuilt(): void {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(
      `No extension build at ${extensionDir} — run \`yarn workspace @shieldedtech/moth-extension build\` first.`,
    );
  }
}

/** Launch Chromium with Moth and any other unpacked extensions alongside it. */
export async function launchExtension(
  others: string[] = [],
): Promise<{ context: BrowserContext; extensionId: string }> {
  const all = [extensionDir, ...others].join(',');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${all}`, `--load-extension=${all}`],
  });
  // The MV3 background service worker registering is the closest thing to
  // "Chrome accepted the extension": a broken manifest or a background
  // bundle that fails to parse never gets this far.
  const isMoth = (url: string) => url.endsWith('/background.js');
  const worker =
    context.serviceWorkers().find((w) => isMoth(w.url())) ??
    (await context.waitForEvent('serviceworker', { predicate: (w) => isMoth(w.url()) }));
  return { context, extensionId: new URL(worker.url()).host };
}

/** Opens an extension page while collecting uncaught exceptions and console errors. */
export async function openPage(
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
