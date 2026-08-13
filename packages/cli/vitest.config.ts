import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests can spin up a daemon subprocess + run real
    // proof generation; default vitest 5s is far too short.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Wallet manifest at ~/.moth/wallets/* is shared. Parallel test
    // files would race the `wallet generate` writes and clobber each
    // other (last writer wins). Run files serially until the fs
    // adapter learns a MOTH_HOME-style override.
    fileParallelism: false,
  },
});
