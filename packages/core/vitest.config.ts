import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The keystore suite derives keys with scrypt at N=2^18 (~256 MiB, ~300ms
    // each), and V8 coverage collection slows that by more than an order of
    // magnitude — enough to blow the 5s default and fail a `--coverage` run for
    // reasons that have nothing to do with the assertions. Raised for the whole
    // project rather than the one file so the next scrypt-backed suite does not
    // rediscover this.
    //
    // 60s covers an instrumented run on a developer machine but NOT on a CI
    // runner, which is several times slower: the KDF-upgrade test took 61.0s
    // there and failed, taking the coverage report down with it. Rather than
    // raise this — it also bounds how long a genuinely hung test wastes in the
    // strict, uninstrumented job, where these same tests take about a second —
    // the `test:coverage` script passes a larger --testTimeout for the one run
    // that needs it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
