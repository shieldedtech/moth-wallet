// Builds the mobile page against this repo's own packages (no copy of moth, no edits to it).
// Run from mobile/ios/build.sh after `yarn build` at the repo root.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const NODE_POLYFILLS = { include: ['buffer', 'process', 'stream', 'util', 'events'], globals: { Buffer: true, process: true, global: true } };
// LEDGER=src swaps the published @midnight-ntwrk/ledger-v8 WASM for one built from source by
// scripts/build-ledger-wasm.sh. The published 8.x builds deserialize wallet state in O(n^2)
// time, so restoring the cached DUST state takes about a minute; see README.md.
const LEDGER_SRC = process.env.LEDGER === 'src';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  publicDir: false,
  resolve: {
    alias: {
      '@shieldedtech/moth-browser': `${REPO}/packages/browser/dist/index.js`,
      'moth-ext': `${REPO}/packages/extension/lib`,
      ...(LEDGER_SRC ? { '@midnight-ntwrk/ledger-v8': `${import.meta.dirname}/../vendor/ledger-v8/midnight_ledger_wasm.js` } : {}),
    },
  },
  plugins: [wasm(), nodePolyfills(NODE_POLYFILLS)],
  build: { target: 'esnext', modulePreload: false, outDir: 'dist', emptyOutDir: true },
});
