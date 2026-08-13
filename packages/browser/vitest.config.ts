import { defineConfig } from 'vitest/config';

// Per-package config so `vitest run` in this package uses these settings
// instead of walking up to the root `projects` config (which resolves its
// project paths relative to the repo root, not here). Every other workspace
// package has its own config for the same reason; browser was missing one,
// which broke `turbo run test`. The browser integration test self-skips
// unless MOTH_BROWSER_TEST=true (it needs Playwright + a devnet).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
