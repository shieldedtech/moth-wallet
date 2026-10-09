import path from 'node:path';
import fs from 'node:fs';
import { test, expect, chromium, type BrowserContext } from '@playwright/test';

// The capsule runtime's page API, `window.midnight.moth.capsule`: a CapsuleConnector a page
// speaks to over the content script's relay, answered by the background. With no wallet unlocked
// the background refuses as the runtime would, and the refusal reaches the page as the blueprint's
// own error — code, reason and path, rebuilt as a BlueprintError — which is what the capsule dApp
// SDK handles. The round trip page → content script → background → page is what passes here.

const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');

test.beforeAll(() => {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`No extension build at ${extensionDir} — run \`yarn workspace @shieldedtech/moth-extension build\` first.`);
  }
});

async function launchExtension(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    channel: process.env.PLAYWRIGHT_CHROMIUM ? undefined : 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  if (context.serviceWorkers().length === 0) await context.waitForEvent('serviceworker');
  return context;
}


test('a page finds the capsule API beside the standard one, and a locked wallet refuses as the runtime does', async () => {
  const context = await launchExtension();
  try {
    const page = await context.newPage();
    // A page of its own origin, so the content script injects as it would into any dApp.
    await page.route('http://capsule.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>dApp</title>' }));
    await page.goto('http://capsule.test/');
    await page.waitForFunction(() => (window as { midnight?: { moth?: { capsule?: unknown } } }).midnight?.moth?.capsule !== undefined);

    const shape = await page.evaluate(() => Object.keys((window as { midnight?: { moth?: { capsule?: object } } }).midnight!.moth!.capsule!).sort());
    expect(shape).toEqual(
      ['connect', 'describe', 'estimateBlueprint', 'makeBlueprintTransaction', 'onCapsuleEvent', 'readLocalState', 'submitBlueprint'].sort(),
    );

    const refusal = await page.evaluate(async () => {
      try {
        await (window as { midnight?: { moth?: { capsule?: { connect(r: unknown): Promise<unknown> } } } }).midnight!.moth!.capsule!.connect({ contract: 'ab'.repeat(32) });
        return null;
      } catch (error) {
        const e = error as Error & { code?: string; reason?: string; path?: unknown };
        return { name: e.name, code: e.code, reason: e.reason, path: e.path, message: e.message };
      }
    });
    expect(refusal).toEqual({ name: 'BlueprintError', code: 'NotConnected', reason: 'locked', path: [], message: 'NotConnected: locked' });

  } finally {
    await context.close();
  }
});
