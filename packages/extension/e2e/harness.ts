// Shared harness for extension E2E tests that drive the built extension and
// the built mock-dapp without a chain.
//
// Offline is enforced, not assumed: every request Chrome would send off this
// machine goes to a proxy that refuses it and records where it was going.
// `page.route` cannot do this job, because the offscreen document's sync
// traffic never passes through Playwright's routing. Chrome sends loopback
// traffic direct, which is what lets the page reach the local mock-dapp server
// — and why the wallet must be on a hosted network such as Preprod rather than
// Undeployed, whose localhost endpoints would bypass the proxy.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

export const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');
const mockDappDir = path.resolve(import.meta.dirname, '..', '..', 'mock-dapp', 'dist');

// The callbacks passed to `worker.evaluate` run in the extension's service
// worker, where `chrome` is a global; this file itself runs in Node.
declare const chrome: {
  storage: {
    session: { get(key: string): Promise<Record<string, unknown>>; set(items: object): Promise<void> };
    local: { get(key: string): Promise<Record<string, unknown>> };
  };
  alarms: { create(name: string, info: { when: number }): Promise<void> };
  runtime: { getContexts(filter: { contextTypes: string[] }): Promise<unknown[]> };
};

export const SEED = 'ab'.repeat(32);
export const PASSWORD = 'correct-horse-battery-staple-9';

export function assertBuilt(): void {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`No extension build at ${extensionDir} — run \`yarn build\` first.`);
  }
  if (!fs.existsSync(path.join(mockDappDir, 'index.html'))) {
    throw new Error(`No mock-dapp build at ${mockDappDir} — run \`yarn build\` first.`);
  }
}

interface Server {
  url: string;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A forward proxy that refuses every request and records the hosts it refused. */
export async function startRefusingProxy(): Promise<Server & { refusedHosts: () => string[] }> {
  const hosts = new Set<string>();
  const server = http.createServer((req, res) => {
    hosts.add(new URL(req.url ?? '', 'http://unknown').host);
    res.writeHead(502).end();
  });
  server.on('connect', (req, socket: net.Socket) => {
    // The browser drops the tunnel as soon as it is refused; that reset is expected.
    socket.on('error', () => {});
    hosts.add(String(req.url).replace(/:\d+$/, ''));
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server), refusedHosts: () => [...hosts] };
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Serves the built mock-dapp. Port 0, so parallel runs never collide. */
export async function startMockDapp(): Promise<Server> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file = path.join(mockDappDir, pathname === '/' ? 'index.html' : path.normalize(pathname));
    if (!file.startsWith(mockDappDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

export interface Extension {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  page(file: string): Promise<Page>;
}

export async function launchExtension(proxyUrl: string): Promise<Extension> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    // The context is launched here rather than by a fixture, so `--headed` has
    // to be read through. E2E_SLOW_MO (ms per action) makes a headed run watchable.
    headless: test.info().project.use.headless ?? true,
    slowMo: Number(process.env.E2E_SLOW_MO ?? 0),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--proxy-server=${proxyUrl}`,
      // Chrome's own update and sync traffic would only add noise to the refused-host log.
      '--disable-background-networking',
      '--disable-component-update',
    ],
  });
  context.setDefaultTimeout(15_000);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  return {
    context,
    worker,
    extensionId,
    async page(file: string) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${file}`);
      return page;
    },
  };
}

/**
 * Restores a hex seed through the setup tab and unlocks it. Defaults to the
 * fixed test seed on Preprod, the setup default.
 */
export async function importWallet(
  ext: Extension,
  { seed = SEED, network = 'Preprod' }: { seed?: string; network?: 'Preprod' | 'Undeployed' } = {},
): Promise<void> {
  const setup = await ext.page('setup.html?mode=import');
  await setup.getByRole('tab', { name: 'Hex seed' }).click();
  await setup.getByRole('textbox', { name: 'Hex seed' }).fill(seed);
  await setup.getByRole('button', { name: 'Continue' }).click();
  const changesNetwork = (await savedNetwork(ext)) !== network.toLowerCase();
  await setup.getByRole('radiogroup', { name: 'Midnight network' }).getByRole('radio', { name: new RegExp(`^${network}`) }).click();
  await setup.getByRole('button', { name: 'Continue' }).click();
  // Saving a different network locks the wallet host and closes its offscreen
  // document without waiting. An import sent inside that window loses its reply
  // ("message channel closed"), so wait for the close to land first.
  if (changesNetwork) await expect.poll(() => hasOffscreenDocument(ext)).toBe(false);
  await setup.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD);
  await setup.getByRole('textbox', { name: 'Confirm password' }).fill(PASSWORD);
  await setup.getByRole('button', { name: 'Continue' }).click();
  await expect(setup.getByRole('heading', { name: "You're all set" })).toBeVisible({ timeout: 60_000 });
  await setup.close();
}

/**
 * The network the background has saved. Read from storage rather than the
 * setup screen, whose radios settle on the saved value only after a load.
 * Absent means the default, Preprod (DEFAULT_SETTINGS in lib/background/settings.ts).
 */
function savedNetwork(ext: Extension): Promise<string> {
  return ext.worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings')) as { settings?: { network?: string } };
    return stored.settings?.network ?? 'preprod';
  });
}

function hasOffscreenDocument(ext: Extension): Promise<boolean> {
  return ext.worker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  });
}

/** Whether the background holds an unlocked session. */
export function isUnlocked(ext: Extension): Promise<boolean> {
  return ext.worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('session');
    return Boolean(stored.session);
  });
}

/**
 * Makes the auto-lock check run now, against a clock that says the wallet has
 * been idle for `idleMinutes`.
 *
 * The real check runs on a one-minute alarm. Rather than wait for it, this
 * backdates the recorded activity and reschedules that same alarm to fire at
 * once, so the production handler does the locking.
 */
export function runAutoLockCheck(ext: Extension, idleMinutes: number): Promise<void> {
  return ext.worker.evaluate(async (minutes) => {
    const past = Date.now() - minutes * 60_000;
    await chrome.storage.session.set({ 'session.lastActivityAt': past, 'session.lastUserActivityAt': past });
    await chrome.alarms.create('auto-lock-check', { when: Date.now() + 100 });
  }, idleMinutes);
}
