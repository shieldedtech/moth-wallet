import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Globbed rather than listed: `yarn turbo run test` discovers workspaces
    // automatically, so a hand-maintained list here would leave a new package
    // gated by CI but absent from the coverage number this config publishes.
    projects: ['packages/*'],
    // Coverage is only configurable at the root of a projects setup, so it lives
    // here rather than in the per-package configs. `text` keeps the number in
    // front of whoever ran the suite; `lcov` is what CI archives.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // `all: true` is what makes an untested module report as 0% rather than
      // being absent from the table — without it `tui` looks fine by being
      // invisible. It cannot be switched on yet: the root `brace-expansion`
      // resolution forces 5.0.9, which dropped its default export, onto every
      // minimatch in the tree, so the glob that enumerates untested files throws
      // `brace_expansion_1.default is not a function`. Turn this on once the
      // resolution is scoped per minimatch major.
      all: false,
      include: ['packages/*/src/**', 'packages/extension/{lib,components}/**'],
      // Extends the defaults rather than replacing them: vitest does not merge
      // this key, so a bare list would silently start counting config files,
      // __mocks__ and dotfiles the moment one appeared under an included path.
      exclude: [
        ...coverageConfigDefaults.exclude,
        // The defaults only exclude a root-level `dist/`, and every package
        // here builds into its own.
        '**/dist/**',
        '**/.wxt/**',
        '**/.output/**',
        // Entrypoints and screens are wired-up shells whose behaviour the
        // DWC-E2E tier covers; counting them here would report browser and
        // terminal UI as untested core logic.
        'packages/extension/entrypoints/**',
        'packages/extension/components/screens/**',
        'packages/tui/src/screens/**',
      ],
    },
  },
});
