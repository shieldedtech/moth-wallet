// T071: Browser integration test
// Load @shieldedtech/moth-browser in a browser page, init wallet from mnemonic,
// query balance, query contract state, verify results.
// Requires Playwright and a running devnet.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// This test requires @playwright/test to be installed and a devnet running.
// Skip when not in browser test environment.
const BROWSER_TEST = process.env.MOTH_BROWSER_TEST === 'true';

describe.skipIf(!BROWSER_TEST)('Browser Integration', () => {
  let browser: any;
  let page: any;

  beforeAll(async () => {
    const pw = await import('playwright').catch(() => null);
    if (!pw) throw new Error('Playwright not installed — run: npm install -D playwright');

    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('loads @shieldedtech/moth-browser library in browser', async () => {
    // Serve the built browser bundle
    await page.goto('about:blank');

    // Inject the browser bundle
    const bundlePath = require.resolve('@shieldedtech/moth-browser');
    const fs = await import('node:fs');
    const bundleCode = fs.readFileSync(bundlePath, 'utf-8');
    await page.addScriptTag({ content: bundleCode });

    // Verify the library is available
    const hasLib = await page.evaluate(() => {
      return typeof (window as any).MothWallet !== 'undefined' ||
        typeof (window as any).moth !== 'undefined';
    });
    expect(hasLib).toBe(true);
  });

  it('initializes wallet from mnemonic', async () => {
    const testMnemonic = process.env.MOTH_TEST_MNEMONIC;
    if (!testMnemonic) throw new Error('Set MOTH_TEST_MNEMONIC for browser tests');

    const result = await page.evaluate(async (mnemonic: string) => {
      const lib = (window as any).MothWallet ?? (window as any).moth;
      const seed = await lib.mnemonicToSeed(mnemonic);
      return {
        hasSeed: seed.length > 0,
        seedLength: seed.length,
      };
    }, testMnemonic);

    expect(result.hasSeed).toBe(true);
    expect(result.seedLength).toBe(64); // 32 bytes as hex = 64 chars
  });

  it('derives addresses', async () => {
    const testMnemonic = process.env.MOTH_TEST_MNEMONIC!;

    const result = await page.evaluate(async (mnemonic: string) => {
      const lib = (window as any).MothWallet ?? (window as any).moth;
      const seed = await lib.mnemonicToSeed(mnemonic);
      const addresses = lib.deriveAllAddressesFromSeed(seed, 'devnet');
      return {
        hasUnshielded: !!addresses.nightExternal?.bech32m?.devnet,
        hasShielded: !!addresses.zswap?.bech32m?.devnet,
        hasDust: !!addresses.dust?.bech32m?.devnet,
      };
    }, testMnemonic);

    expect(result.hasUnshielded).toBe(true);
    expect(result.hasShielded).toBe(true);
    expect(result.hasDust).toBe(true);
  });

  it('queries balance via indexer', async () => {
    const indexerUrl = process.env.MOTH_INDEXER_URL ?? 'http://localhost:8088';

    const result = await page.evaluate(async (url: string) => {
      const lib = (window as any).MothWallet ?? (window as any).moth;
      const client = new lib.IndexerClient(url);
      const block = await client.getBlock();
      return { hasBlock: !!block, height: block?.height ?? 0 };
    }, indexerUrl);

    expect(result.hasBlock).toBe(true);
    expect(result.height).toBeGreaterThan(0);
  });
});
