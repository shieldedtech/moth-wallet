import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { assertBuilt, extensionDir, launchExtension, openPage } from './extension';

test.beforeAll(assertBuilt);

/**
 * The URL of the proof worker the current build spawns. Builds into a fixed
 * directory can leave older hashed chunks beside it, so the name is followed
 * from the newest wallet-host chunk, which is what constructs the worker.
 */
function builtProofWorker(): string {
  const assets = path.join(extensionDir, 'assets');
  const hosts = fs
    .readdirSync(assets)
    .filter((f) => /^wallet-host-.*\.js$/.test(f))
    .map((f) => ({ f, at: fs.statSync(path.join(assets, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  expect(hosts.length, 'no wallet-host chunk in the build').toBeGreaterThan(0);
  // wallet-host imports Vite's `?worker` wrapper, which names the worker script.
  const wrapper = fs.readFileSync(path.join(assets, hosts[0]!.f), 'utf8').match(/import\("\.\/(proof-worker-[A-Za-z0-9_-]+\.js)"\)/);
  expect(wrapper, 'the wallet-host chunk imports no proof worker').not.toBeNull();
  const script = fs.readFileSync(path.join(assets, wrapper![1]!), 'utf8').match(/new Worker\("([^"]+)"/);
  expect(script, `${wrapper![1]} constructs no worker`).not.toBeNull();
  return script![1]!;
}

// The proof pool posts a job the moment it spawns a worker. When the built
// worker instantiated zkir's WASM with a top-level await before installing its
// message handler, that first job was dropped and every local proof waited
// forever without asking for a key. Only the bundled worker shows this, so it is
// checked here against the build rather than in a unit test.
test('the built proof worker loads no WASM before its message handler is set', () => {
  // Whether the dropped-job race shows depends on timing (it rarely does when
  // the extension reads WASM from disk, often when the busy wallet worker spawns
  // the pool), so the condition that makes it impossible is checked directly:
  // the worker script itself instantiates nothing.
  const script = fs.readFileSync(path.join(extensionDir, builtProofWorker()), 'utf8');
  expect(script).not.toMatch(/WebAssembly\.instantiate/);
});

test('the built proof worker answers a job posted the moment it starts', async () => {
  const worker = builtProofWorker();

  const { context, extensionId } = await launchExtension();
  try {
    const { page } = await openPage(context, extensionId, 'sidepanel.html');
    const reply = await page.evaluate(
      (url) =>
        new Promise<{ ok?: boolean; error?: { message?: string } } | 'no reply'>((resolve) => {
          const w = new Worker(url, { type: 'module' });
          w.onmessage = (event) => resolve(event.data);
          w.onerror = (event) => resolve({ ok: false, error: { message: `worker error: ${event.message}` } });
          // Not a proof preimage: zkir rejects it at once, which is the answer
          // wanted here. A worker that dropped it never replies.
          w.postMessage({ id: 1, op: 'prove', zkir: 'v2', preimage: new Uint8Array([1, 2, 3]) });
          setTimeout(() => resolve('no reply'), 20_000);
        }),
      worker,
    );

    expect(reply).not.toBe('no reply');
    expect(reply).toMatchObject({ ok: false });
    expect((reply as { error?: { message?: string } }).error?.message).toContain('proof-preimage');
  } finally {
    await context.close();
  }
});
