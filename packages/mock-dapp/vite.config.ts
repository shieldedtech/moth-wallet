import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  // Let vite-plugin-wasm transform ledger-v8. Vite's dev dependency
  // optimizer otherwise sees the package's native `.wasm` import first and
  // rejects the WebAssembly ESM integration proposal.
  optimizeDeps: {
    exclude: ['@midnight-ntwrk/ledger-v8'],
  },
  build: {
    // ledger-v8's WASM bridge uses top-level await.
    target: 'esnext',
  },
});
