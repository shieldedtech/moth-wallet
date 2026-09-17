import { defineConfig } from '@playwright/test';

// E2E tests use the `.e2e.ts` suffix so vitest's default `.test`/`.spec`
// globs never pick them up, and vice versa.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // Every test loads the unpacked extension into its own persistent Chromium
  // context; running them serially keeps profile directories from colliding.
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
});
