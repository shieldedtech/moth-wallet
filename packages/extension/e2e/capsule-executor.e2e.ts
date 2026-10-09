import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { CAPSULE_EXECUTOR_PAGE, CAPSULE_SANDBOX_CSP } from '../lib/capsule/sandbox-csp';

// The capsule executor is a sandbox page: the one document of the extension that may compile text,
// held to an opaque origin with no extension API. These tests load the built extension and speak
// the executor's own port protocol to that page from another page of the extension, as the
// offscreen document does — so what passes here is the confinement itself: the manifest's CSP as
// written, the page refusing to serve outside a frame, and a compiled contract evaluated and run
// inside one.

const extensionDir = path.resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');
// The runtime's checkout is a sibling of this one (the portals in package.json say so too).
const BUILDS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'capsule-runtime', 'contracts', 'build');
const COIN_PUBLIC_KEY = '11'.repeat(32);

test.beforeAll(() => {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`No extension build at ${extensionDir} — run \`yarn workspace @shieldedtech/moth-extension build\` first.`);
  }
});

async function launchExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: process.env.PLAYWRIGHT_CHROMIUM ? undefined : 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).host };
}

type Request = { kind: 'request'; id: number; method: string; params: unknown[] };

/** From an ordinary page of the extension, embeds the executor page and speaks its port protocol. */
async function withExecutor<T>(
  page: Page,
  extensionId: string,
  run: (call: (method: string, ...params: unknown[]) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(
    ({ url, message }) =>
      new Promise<void>((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.src = url;
        window.addEventListener('message', function ready(event: MessageEvent<unknown>) {
          if (event.source !== frame.contentWindow || event.data !== 'capsule-executor-ready') return;
          window.removeEventListener('message', ready);
          const channel = new MessageChannel();
          frame.contentWindow?.postMessage(message, '*', [channel.port2]);
          const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
          channel.port1.onmessage = (event: MessageEvent<{ kind: string; id: number; result?: unknown; message?: string }>) => {
            const entry = waiting.get(event.data.id);
            if (entry === undefined) return;
            waiting.delete(event.data.id);
            if (event.data.kind === 'response') entry.resolve(event.data.result);
            else entry.reject(new Error(event.data.message));
          };
          let next = 1;
          (window as unknown as { __call: unknown }).__call = (method: string, ...params: unknown[]) =>
            new Promise((res, rej) => {
              const id = next++;
              waiting.set(id, { resolve: res, reject: rej });
              channel.port1.postMessage({ kind: 'request', id, method, params } satisfies Request);
            });
          resolve();
        });
        frame.addEventListener('error', () => reject(new Error('the executor page did not load')));
        document.body.appendChild(frame);
      }),
    { url: `chrome-extension://${extensionId}/${CAPSULE_EXECUTOR_PAGE}`, message: 'capsule-executor-port' },
  );
  const call = (method: string, ...params: unknown[]) =>
    page.evaluate(
      ({ method, params }) =>
        (window as unknown as { __call: (m: string, ...p: unknown[]) => Promise<unknown> }).__call(method, ...params),
      { method, params },
    );
  return run(call);
}

function bundle(name: string): { fingerprint: string; indexJs: string } {
  const bytes = fs.readFileSync(path.join(BUILDS, name, 'contract', 'index.js'));
  return { fingerprint: createHash('sha256').update(bytes).digest('hex'), indexJs: bytes.toString('hex') };
}

test('the manifest sandboxes the executor page under the CSP as written', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')) as {
    sandbox?: { pages?: string[] };
    content_security_policy?: { sandbox?: string };
  };
  expect(manifest.sandbox?.pages).toEqual([CAPSULE_EXECUTOR_PAGE]);
  expect(manifest.content_security_policy?.sandbox).toBe(CAPSULE_SANDBOX_CSP);
});

test('the executor page refuses to serve when opened as a page of its own', async () => {
  const { context, extensionId } = await launchExtension();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/${CAPSULE_EXECUTOR_PAGE}`);
    await page.waitForTimeout(500);
    expect(errors).toEqual([expect.stringContaining('serves only from a sandboxed frame')]);
  } finally {
    await context.close();
  }
});

test('embedded, the executor page evaluates a compiled module as text and runs a circuit', async () => {
  test.setTimeout(60_000);
  const { context, extensionId } = await launchExtension();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const counter = bundle('Counter');
    await withExecutor(page, extensionId, async (call) => {
      const description = (await call('load', counter.fingerprint, 'Counter', counter.indexJs)) as {
        name: string;
        expectedVk: Record<string, string>;
      };
      expect(description.name).toBe('Counter');
      expect(Object.keys(description.expectedVk)).toEqual(['increment']);
      const deployed = (await call('initialState', counter.fingerprint, COIN_PUBLIC_KEY, [])) as { state: string };
      const local = await call('initialLocalState', counter.fingerprint);
      const result = (await call('rehearse', 1, {
        fingerprint: counter.fingerprint,
        address: 'ab'.repeat(32),
        circuit: 'increment',
        args: [],
        publicState: deployed.state,
        localState: local,
        coinPublicKey: COIN_PUBLIC_KEY,
        basis: { blockHash: '11'.repeat(32), time: 1_760_000_000 },
        hostAnswers: {},
      })) as { trace: Array<{ circuitId: string }>; localStates: Record<string, unknown> };
      expect(result.trace.map((entry) => entry.circuitId)).toEqual(['increment']);
      const after = (await call('readLocalFields', counter.fingerprint, result.localStates['ab'.repeat(32)], deployed.state)) as Record<
        string,
        unknown
      >;
      expect(after['count']).toEqual({ type: 'counter', value: '1' });
      await expect(call('load', 'ff'.repeat(32), 'nope', Buffer.from('export const x = 1;\n').toString('hex'))).rejects.toThrow(
        /not a compiled contract module/,
      );
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
