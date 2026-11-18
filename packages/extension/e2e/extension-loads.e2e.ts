import { test, expect, type Page } from '@playwright/test';
import { assertBuilt, launchExtension, openPage } from './extension';

test.beforeAll(assertBuilt);

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
