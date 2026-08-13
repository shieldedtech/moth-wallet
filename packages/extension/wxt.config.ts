import { defineConfig } from 'wxt';
import { nodePolyfills, type PolyfillOptions } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import tailwindcss from '@tailwindcss/vite';
import { MESSAGES } from './lib/i18n/messages';

// Core keeps Buffer/process usage (address, proof, contract paths) and the
// wallet-sdk pulls in stream/util/events transitively. The dedicated wallet
// worker is bundled by a SEPARATE rollup pass that applies only `worker.plugins`
// (the main `vite.plugins` are NOT applied to it), so it needs its own copy of
// this treatment — shared here to keep the two in lock-step.
const NODE_POLYFILLS: PolyfillOptions = {
  include: ['buffer', 'process', 'stream', 'util', 'events'],
  globals: { Buffer: true, process: true, global: true },
};

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  zip: {
    name: 'moth-extension',
    artifactTemplate: '{{name}}-{{packageVersion}}-{{browser}}.zip',
  },
  // The English `_locales` catalog is generated from the TS source of truth
  // (lib/i18n/messages) on every build — it can never drift. Translations are
  // added as further checked-in public/_locales/<lang>/messages.json files.
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push({
        relativeDest: '_locales/en/messages.json',
        contents: JSON.stringify(
          Object.fromEntries(Object.entries(MESSAGES).map(([key, message]) => [key, { message }])),
          null,
          2,
        ),
      });
    },
  },
  manifest: ({ browser }) => ({
    name: '__MSG_common_extName__',
    description: '__MSG_common_extDescription__',
    default_locale: 'en',
    permissions: [
      'storage',
      'unlimitedStorage',
      // Drives the inactivity auto-lock check; wakes the SW even while idle.
      'alarms',
      // Attaches an optional auth header to node requests. A browser cannot set
      // headers on a WebSocket handshake, and the node connection is a
      // WebSocket, so declarativeNetRequest is the only route to it. The
      // WithHostAccess variant reuses host_permissions rather than widening
      // them: it grants header rewriting on hosts already declared below, and
      // no new access.
      'declarativeNetRequestWithHostAccess',
      // Chrome-only; Firefox gets sidebar_action from the sidepanel entrypoint.
      ...(browser === 'firefox' ? [] : ['sidePanel', 'offscreen']),
    ],
    host_permissions: [
      'https://*.midnight.network/*',
      'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/*',
      'http://localhost/*',
    ],
    web_accessible_resources: [{ resources: ['injected.js'], matches: ['<all_urls>'] }],
    content_security_policy: {
      // wasm-unsafe-eval: ledger-v8 loads its WASM in the offscreen document's
      // dedicated worker (an extension page context, so extension_pages applies).
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  }),
  vite: () => ({
    plugins: [
      // ledger-v8 ships WASM via the ESM-integration proposal, which emits a
      // top-level await. A Chrome MV3 service worker cannot have TLA in its
      // module graph, so the WASM runs in the offscreen document's worker
      // instead; the background stays a classic (WASM-free) service worker.
      // KNOWN LIMITATION: Firefox has neither offscreen documents nor module
      // background scripts (bugzilla #1803950) — Firefox support is deferred.
      wasm() as never,
      tailwindcss() as never,
      nodePolyfills(NODE_POLYFILLS) as never,
    ],
    build: {
      target: 'esnext',
      // No <link rel="modulepreload"> in the generated HTML. Vite emits one per
      // shared chunk per entry, with `crossorigin` — and on a chrome-extension://
      // URL that puts the preload in a different fetch world from the module load
      // that follows, so Chrome discards it and logs "cross-world extension
      // resource mismatch", then logs a second time when the unused preload
      // expires. Several lines per page load, every load.
      //
      // Nothing is lost by dropping them: preloading exists to hide network
      // latency, and these resources come off local disk inside the extension
      // package. Chrome was already refusing to use them, so the only thing that
      // disappears is the warnings about them.
      modulePreload: false,
    },
    // Sub-build for the `?worker` import (wallet-worker.ts). `format: 'es'` is
    // required for the WASM proxy's top-level await and the worker's lazy host
    // import. No tailwind here — the worker renders nothing.
    worker: {
      format: 'es' as const,
      plugins: () => [wasm() as never, nodePolyfills(NODE_POLYFILLS) as never],
    },
  }),
});
