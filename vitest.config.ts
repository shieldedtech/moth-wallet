import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/cli',
      'packages/browser',
      'packages/tui',
      'packages/extension',
      'packages/mock-dapp',
    ],
  },
});
